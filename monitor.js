/**
 * Polymarket 5-Min Arb Scanner — v6
 * KEY FIX: Tracks markets AFTER close, polls during oracle resolution window
 * The arb opportunity is in the 0-60s gap between market close & oracle resolve
 *
 * Run: node monitor.js
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

// ── Config ────────────────────────────────────────────────
const THRESHOLD     = 0.05;    // ARB: both sides < 5¢
const NEAR_SUM      = 0.12;    // NEAR: sum < 12¢
const SCAN_IDLE     = 15000;   // ms — no markets closing soon
const SCAN_WATCH    = 3000;    // ms — market closing in <2 min
const SCAN_FAST     = 1000;    // ms — market closed, in resolution window
const RESOLUTION_WINDOW = 90;  // seconds to keep polling after market close
const GAMMA_API     = 'https://gamma-api.polymarket.com';
const CLOB_API      = 'https://clob.polymarket.com';
const LOG_FILE      = path.join(__dirname, 'arb_log.txt');
const JSONL_FILE    = path.join(__dirname, 'arb_log.jsonl');
// ─────────────────────────────────────────────────────────

// ── Market memory — KEY: we remember markets after they close ──
// { conditionId: { market, closedAt, lastSeen } }
const trackedMarkets = new Map();

const stats = {
  scans: 0, arbFound: 0, nearFound: 0,
  lowestSum: 1.0, lowestSumInfo: '',
  sessionStart: new Date(),
};

let currentInterval = SCAN_IDLE;
let timer = null;

const C = {
  reset:'\x1b[0m', green:'\x1b[32m', red:'\x1b[31m', amber:'\x1b[33m',
  blue:'\x1b[34m', muted:'\x1b[90m', bold:'\x1b[1m',
  bgGreen:'\x1b[42;30m', bgAmber:'\x1b[43;30m', bgRed:'\x1b[41;97m',
};
const c  = (col, txt) => C[col] + txt + C.reset;
const ts = () => c('muted', new Date().toLocaleTimeString('en-US', {hour12:false}));

function logEvent(type, data) {
  const entry = { ts: new Date().toISOString(), type, ...data };
  fs.appendFileSync(JSONL_FILE, JSON.stringify(entry) + '\n');
  fs.appendFileSync(LOG_FILE, `[${entry.ts}] ${type} | ${JSON.stringify(data)}\n`);
}

async function get(url, timeout = 5000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
      signal: ctrl.signal
    });
    clearTimeout(t);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch(e) { clearTimeout(t); throw e; }
}

function getEndTime(m) {
  for (const f of ['endDate','endDateIso','end_date_iso','end_date','closeTime']) {
    if (m[f]) return new Date(m[f]);
  }
  return null;
}

function detectAsset(q) {
  q = (q || '').toLowerCase();
  if (q.includes('bitcoin')  || q.includes(' btc'))   return 'BTC';
  if (q.includes('ethereum') || q.includes(' eth'))   return 'ETH';
  if (q.includes('solana')   || q.includes(' sol'))   return 'SOL';
  if (q.includes('xrp')      || q.includes('ripple')) return 'XRP';
  if (q.includes('dogecoin') || q.includes('doge'))   return 'DOGE';
  if (q.includes('bnb'))                              return 'BNB';
  if (q.includes('hyperliquid'))                      return 'HYPE';
  return 'CRPT';
}

// ── Fetch upcoming markets & add to tracker ───────────────
async function refreshUpcomingMarkets() {
  const nowMs = Date.now();
  // Fetch markets ending in next 10 min (while still active)
  const soon = new Date(nowMs + 10 * 60000).toISOString();
  const past = new Date(nowMs - 10000).toISOString(); // 10s ago

  try {
    const data = await get(
      `${GAMMA_API}/markets?closed=false&active=true&limit=500&end_date_min=${past}&end_date_max=${soon}`
    );
    const list = Array.isArray(data) ? data : (data.markets || data.data || []);

    for (const m of list) {
      const id  = m.conditionId || m.id;
      const end = getEndTime(m);
      if (!id || !end) continue;

      if (!trackedMarkets.has(id)) {
        trackedMarkets.set(id, { market: m, end, closedAt: null, phase: 'upcoming' });
        if (process.env.DEBUG) console.log(c('muted', `  tracking: ${m.question?.slice(0,50)}`));
      } else {
        // Update market data (prices may have changed)
        trackedMarkets.get(id).market = m;
      }
    }
  } catch (e) {
    // Silently fail — we still have our tracked markets
    if (process.env.DEBUG) console.log(c('red', '  refresh error: ' + e.message));
  }
}

// ── Clean up markets past resolution window ───────────────
function pruneExpiredMarkets() {
  const now = Date.now();
  for (const [id, entry] of trackedMarkets) {
    const secsAfterClose = entry.closedAt ? (now - entry.closedAt) / 1000 : null;
    if (secsAfterClose && secsAfterClose > RESOLUTION_WINDOW + 30) {
      trackedMarkets.delete(id);
    }
  }
}

// ── Get CLOB prices (freshest, most important in res window) 
async function getPrices(m) {
  const tokens = (m.clobTokenIds || [])
    .map(t => typeof t === 'object' ? (t.token_id || t.id) : t)
    .filter(Boolean);

  // CLOB order book — best ask price (what you'd actually pay)
  if (tokens.length >= 2) {
    try {
      const [b0, b1] = await Promise.all([
        get(`${CLOB_API}/book?token_id=${tokens[0]}`, 3000),
        get(`${CLOB_API}/book?token_id=${tokens[1]}`, 3000),
      ]);
      const bestAsk = b => b?.asks?.length ? Math.min(...b.asks.map(a => parseFloat(a.price))) : null;
      const up = bestAsk(b0), down = bestAsk(b1);
      if (up !== null && down !== null) return { up, down, src: 'book' };
    } catch {}

    // Fallback: midpoint
    try {
      const [d0, d1] = await Promise.all([
        get(`${CLOB_API}/midpoint?token_id=${tokens[0]}`, 3000),
        get(`${CLOB_API}/midpoint?token_id=${tokens[1]}`, 3000),
      ]);
      const up = parseFloat(d0.mid), down = parseFloat(d1.mid);
      if (up > 0 && down > 0) return { up, down, src: 'mid' };
    } catch {}
  }

  // Last resort: embedded outcomePrices (may be stale)
  if (m.outcomePrices) {
    try {
      const p = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : m.outcomePrices;
      const up = parseFloat(p[0]), down = parseFloat(p[1]);
      if (up > 0 && down > 0) return { up, down, src: 'embedded⚠' };
    } catch {}
  }

  return null;
}

// ── Process one tracked market ────────────────────────────
async function processMarket(id, entry) {
  const { market, end } = entry;
  const now     = Date.now();
  const secsToClose  = (end - now) / 1000;
  const secsAfterClose = entry.closedAt ? (now - entry.closedAt) / 1000 : null;

  // Mark as closed when we pass end time
  if (secsToClose <= 0 && !entry.closedAt) {
    entry.closedAt = now;
    entry.phase = 'resolution';
    const asset = detectAsset(market.question);
    console.log(
      ts(), c('blue', '⏰ CLOSED →'),
      c('bold', asset),
      c('amber', `now in resolution window`),
      c('muted', `(oracle has ~30s to resolve)`)
    );
  }

  // Skip if past resolution window
  if (secsAfterClose !== null && secsAfterClose > RESOLUTION_WINDOW) {
    entry.phase = 'expired';
    return;
  }

  // Only fetch prices when close to or past close time
  if (secsToClose > 120) return; // don't bother yet

  const prices = await getPrices(market);
  if (!prices) return;

  const sum    = prices.up + prices.down;
  const asset  = detectAsset(market.question);
  const phase  = entry.phase;

  // Track lowest sum
  if (sum < stats.lowestSum) {
    stats.lowestSum = sum;
    stats.lowestSumInfo = `${asset} @ ${new Date().toLocaleTimeString()} (${phase})`;
  }

  const up_c   = (prices.up   * 100).toFixed(1);
  const dn_c   = (prices.down * 100).toFixed(1);
  const sum_c  = (sum * 100).toFixed(1);
  const profit = ((1 - sum) * 100).toFixed(1);
  const isArb  = prices.up < THRESHOLD && prices.down < THRESHOLD;
  const isNear = sum < NEAR_SUM && !isArb;

  // Timer string
  let timerStr;
  if (secsAfterClose !== null) {
    timerStr = c('red', `+${secsAfterClose.toFixed(1)}s after close`);
  } else if (secsToClose < 10) {
    timerStr = c('red', `${secsToClose.toFixed(1)}s to close`);
  } else if (secsToClose < 60) {
    timerStr = c('amber', `${Math.floor(secsToClose)}s to close`);
  } else {
    timerStr = c('muted', `${Math.floor(secsToClose/60)}m${String(Math.floor(secsToClose%60)).padStart(2,'0')}s`);
  }

  if (isArb) {
    stats.arbFound++;
    logEvent('ARB', {
      asset, phase,
      up_c, dn_c, sum_c, profit_c: profit,
      secs_after_close: secsAfterClose?.toFixed(1),
      secs_to_close: secsToClose.toFixed(1),
      src: prices.src,
      market_id: id
    });

    console.log('');
    console.log(c('bgGreen', '  ████████████████████████████████████████████  '));
    console.log(c('bgGreen', `  ██  ARB DETECTED @ ${new Date().toLocaleTimeString('en-US',{hour12:false})}  ██  `));
    console.log(c('bgGreen', '  ████████████████████████████████████████████  '));
    console.log(
      c('bold', c('green', `  ${asset.padEnd(5)}`)),
      c('green', `UP=${up_c}¢  DOWN=${dn_c}¢  SUM=${sum_c}¢`),
      c('bold', c('green', `→ PROFIT +${profit}¢/share`)),
      `[${timerStr}]`,
      c('muted', `[phase:${phase}]`)
    );
    console.log(c('green', `  Buy both sides. One pays 100¢. Logged to arb_log.txt`));
    console.log('');

  } else if (isNear) {
    stats.nearFound++;
    logEvent('NEAR', { asset, phase, up_c, dn_c, sum_c, secs_after_close: secsAfterClose?.toFixed(1) });
    console.log(
      ts(), c('bgAmber', ' NEAR '),
      c('amber', asset.padEnd(5)),
      c('amber', `UP=${up_c}¢  DN=${dn_c}¢  SUM=${sum_c}¢`),
      `[${timerStr}]`,
      c('muted', `[${phase}] src:${prices.src}`)
    );

  } else if (secsToClose < 60 || secsAfterClose !== null) {
    // Print all markets in final 60s + all in resolution window
    const sumColor = sum < 0.3 ? 'amber' : 'muted';
    console.log(
      ts(), c('muted', '  ·  '),
      c('muted', asset.padEnd(5)),
      c(sumColor, `UP=${up_c}¢  DN=${dn_c}¢  SUM=${sum_c}¢`),
      `[${timerStr}]`,
      c('muted', `[${phase}]`)
    );
  }
}

// ── Adapt scan rate ───────────────────────────────────────
function adaptRate() {
  const now = Date.now();
  let hasResolution = false;
  let hasClosingSoon = false;

  for (const [, entry] of trackedMarkets) {
    if (entry.phase === 'expired') continue;
    const secsToClose = (entry.end - now) / 1000;
    if (entry.phase === 'resolution') { hasResolution = true; break; }
    if (secsToClose < 120) hasClosingSoon = true;
  }

  const target = hasResolution ? SCAN_FAST : hasClosingSoon ? SCAN_WATCH : SCAN_IDLE;

  if (target !== currentInterval) {
    currentInterval = target;
    clearInterval(timer);
    timer = setInterval(scan, currentInterval);
    const label = target === SCAN_FAST  ? c('red',   `FAST 1s — in resolution window!`)
                : target === SCAN_WATCH ? c('amber', `WATCHING 3s — market closing soon`)
                :                         c('muted', `IDLE 15s`);
    console.log(ts(), c('blue', '⟳'), label);
  }
}

// ── Main scan ─────────────────────────────────────────────
async function scan() {
  stats.scans++;
  const isFast = currentInterval === SCAN_FAST;

  // Refresh upcoming markets every 30s or when idle
  if (stats.scans % Math.max(1, Math.floor(30000 / currentInterval)) === 0 || stats.scans === 1) {
    await refreshUpcomingMarkets();
    pruneExpiredMarkets();
  }

  if (!isFast) {
    const active = [...trackedMarkets.values()].filter(e => e.phase !== 'expired').length;
    console.log(
      '\n' + c('blue', `— SCAN #${stats.scans}`) +
      c('muted', ` @ ${new Date().toLocaleTimeString('en-US',{hour12:false})}`) +
      c('muted', ` | tracking: ${active} mkts | ARB: ${stats.arbFound} | NEAR: ${stats.nearFound} | lowest sum: ${(stats.lowestSum*100).toFixed(1)}¢`)
    );
  }

  // Process all tracked markets
  for (const [id, entry] of trackedMarkets) {
    if (entry.phase === 'expired') continue;
    try {
      await processMarket(id, entry);
    } catch (e) {
      if (process.env.DEBUG) console.log(c('red', `  error: ${e.message}`));
    }
  }

  adaptRate();
}

// ── Start ─────────────────────────────────────────────────
console.log(c('bold', c('green', `
╔══════════════════════════════════════════════════════════════╗
║      POLYMARKET ARB SCANNER  v6  —  Resolution Window Mode   ║
║  Tracks markets AFTER close during Chainlink oracle delay     ║
╚══════════════════════════════════════════════════════════════╝`)));
console.log(c('amber', `  KEY INSIGHT: The arb window is the ${RESOLUTION_WINDOW}s gap between`));
console.log(c('amber', `  market close and oracle resolution. Bot tracks this window.\n`));
console.log(c('muted', `  ARB  : both sides < ${THRESHOLD*100}¢`));
console.log(c('muted', `  NEAR : sum < ${NEAR_SUM*100}¢`));
console.log(c('muted', `  Logs : arb_log.txt + arb_log.jsonl\n`));

process.on('SIGINT', () => {
  console.log('\n' + c('amber', `Stopped after ${stats.scans} scans`));
  console.log(c('green',  `ARB signals : ${stats.arbFound}`));
  console.log(c('amber',  `NEAR signals: ${stats.nearFound}`));
  console.log(c('muted',  `Lowest sum  : ${(stats.lowestSum*100).toFixed(1)}¢ — ${stats.lowestSumInfo}`));
  process.exit(0);
});

if (typeof globalThis.fetch === 'undefined') {
  console.error('Need Node 18+'); process.exit(1);
}

const header = `=== started ${new Date().toISOString()} ===\n`;
fs.appendFileSync(LOG_FILE, header);
fs.appendFileSync(JSONL_FILE, JSON.stringify({ ts: new Date().toISOString(), type: 'START' }) + '\n');

await scan();
timer = setInterval(scan, currentInterval);
