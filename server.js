const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const fetch        = require('node-fetch');
const fs           = require('fs');
const path         = require('path');

const app = express();

// ══════════════════════════════════════════
// ENV VARS
// ══════════════════════════════════════════
const FINNHUB_KEY        = process.env.FINNHUB_KEY;
const ONESIGNAL_APP_ID   = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY  = process.env.ONESIGNAL_API_KEY;
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET;
const ALLOWED_ORIGIN     = process.env.ALLOWED_ORIGIN || 'https://signaledge.guru';
// Twilio SMS
const TWILIO_SID         = process.env.TWILIO_SID;
const TWILIO_AUTH        = process.env.TWILIO_AUTH;
const TWILIO_FROM        = process.env.TWILIO_FROM; // e.g. +15551234567
// Data dir (Render persistent disk)
const DATA_DIR           = process.env.DATA_DIR || '/data';
const SUBSCRIBERS_FILE   = path.join(DATA_DIR, 'subscribers.json');
const HISTORY_FILE       = path.join(DATA_DIR, 'signal-history.json');

// Ensure data dir exists (fallback to /tmp if /data doesn't exist)
let DATA_READY = false;
try {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  DATA_READY = true;
} catch(e) {
  console.warn(`[DATA] Cannot use ${DATA_DIR}, falling back to /tmp`);
}
if (!DATA_READY) {
  try {
    fs.mkdirSync('/tmp/signaledge-data', { recursive: true });
    DATA_READY = true;
  } catch(e) { console.error('[DATA] No writable dir available'); }
}

// ══════════════════════════════════════════
// SECURITY
// ══════════════════════════════════════════
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));

app.use(cors({
  origin: function(origin, callback) {
    const allowed = [
      ALLOWED_ORIGIN,
      'https://www.signaledge.guru',
      'https://deft-chimera-b83806.netlify.app',
      'http://localhost:3000'
    ];
    if (!origin || allowed.includes(origin)) callback(null, true);
    else callback(new Error('Not allowed by CORS'));
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '500kb' })); // Bumped for market-scan payloads

const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 1000,
  message: { error: 'Too many requests — please wait a minute and try again.' },
  standardHeaders: true, legacyHeaders: false
});
const priceLimiter = rateLimit({ windowMs: 60 * 1000, max: 60, message: { error: 'Rate limit' } });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, message: { error: 'Webhook rate limit' } });
// Waitlist: 10 signups per IP per hour (prevents spam but allows retries)
const waitlistLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, max: 10,
  message: { error: 'Too many signup attempts. Please try again in an hour.' },
  standardHeaders: true, legacyHeaders: false
});

app.use(generalLimiter);

// ══════════════════════════════════════════
// IN-MEMORY STORES
// ══════════════════════════════════════════
const signals     = []; // Institutional OB signals
const aiSignals   = []; // AI (RSI/MACD/Vol/Breakout) signals
const priceCache  = {};
let   marketScan  = { coins: {}, updatedAt: 0 }; // Real tags for top 200

// Waitlist (persisted to disk)
const waitlist = []; // { email, phone, ts, ip }
const waitlistEmails = new Set(); // dedupe

// Signal history (persisted, auto-tracked)
const signalHistory = []; // { id, type, symbol, entry, sl, tp1, tp2, status, opened_at, closed_at, engine }

// Stats tracking
const stats = {
  startTs: Date.now(),
  scanCount: 0,
  totalSignalsFired: 0,
  signalsToday: 0,
  todayStartTs: Date.now()
};

// Reset daily counter every 24h
setInterval(() => {
  stats.signalsToday = 0;
  stats.todayStartTs = Date.now();
}, 24 * 60 * 60 * 1000);

// ══════════════════════════════════════════
// PERSISTENCE HELPERS
// ══════════════════════════════════════════
function saveSubscribers() {
  if (!DATA_READY) return;
  try {
    fs.writeFileSync(SUBSCRIBERS_FILE, JSON.stringify(waitlist, null, 2));
  } catch(e) { console.error('[PERSIST] Subscribers save failed:', e.message); }
}

function loadSubscribers() {
  if (!DATA_READY) return;
  try {
    if (fs.existsSync(SUBSCRIBERS_FILE)) {
      const data = JSON.parse(fs.readFileSync(SUBSCRIBERS_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        data.forEach(s => {
          if (s.email && !waitlistEmails.has(s.email)) {
            waitlist.push(s);
            waitlistEmails.add(s.email);
          }
        });
        console.log(`[PERSIST] Loaded ${waitlist.length} subscribers from disk`);
      }
    }
  } catch(e) { console.error('[PERSIST] Subscribers load failed:', e.message); }
}

function saveHistory() {
  if (!DATA_READY) return;
  try {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(signalHistory.slice(0, 200), null, 2));
  } catch(e) { console.error('[PERSIST] History save failed:', e.message); }
}

function loadHistory() {
  if (!DATA_READY) return;
  try {
    if (fs.existsSync(HISTORY_FILE)) {
      const data = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
      if (Array.isArray(data)) {
        data.forEach(s => signalHistory.push(s));
        console.log(`[PERSIST] Loaded ${signalHistory.length} historical signals from disk`);
      }
    }
  } catch(e) { console.error('[PERSIST] History load failed:', e.message); }
}

loadSubscribers();
loadHistory();

// ══════════════════════════════════════════
// TWILIO SMS
// ══════════════════════════════════════════
async function sendSMSBlast(message) {
  if (!TWILIO_SID || !TWILIO_AUTH || !TWILIO_FROM) return;
  const phoneSubs = waitlist.filter(w => w.phone && w.phone.length >= 7);
  if (!phoneSubs.length) return;

  const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_AUTH}`).toString('base64');
  const url = `https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`;

  let sent = 0, failed = 0;
  for (const sub of phoneSubs) {
    try {
      const body = new URLSearchParams({
        To: sub.phone, From: TWILIO_FROM, Body: message
      });
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString()
      });
      if (r.ok) sent++; else failed++;
    } catch(e) { failed++; }
  }
  console.log(`[SMS] Blast: ${sent} sent, ${failed} failed`);
}

// ══════════════════════════════════════════
// SIGNAL HISTORY TRACKING
// Called periodically to update status based on current price
// ══════════════════════════════════════════
async function updateSignalHistory() {
  const tracking = signalHistory.filter(s => s.status === 'tracking');
  if (!tracking.length) return;

  // Pull current prices from CoinGecko markets cache
  const cached = priceCache['_markets'];
  if (!cached || !cached.data || !Array.isArray(cached.data.coins)) return;

  const priceMap = {};
  cached.data.coins.forEach(c => { if (c.symbol && c.price) priceMap[c.symbol.toUpperCase()] = c.price; });

  for (const sig of tracking) {
    const current = priceMap[(sig.symbol || '').toUpperCase()];
    if (!current) continue;

    const isBuy = sig.type === 'buy';
    const openedAgo = Date.now() - new Date(sig.opened_at).getTime();
    const maxAge = 7 * 24 * 60 * 60 * 1000; // 7 days

    if (isBuy) {
      if (sig.tp1 && current >= sig.tp1) { sig.status = 'hit_tp1'; sig.closed_at = new Date().toISOString(); sig.close_price = current; }
      else if (sig.sl && current <= sig.sl)   { sig.status = 'hit_sl'; sig.closed_at = new Date().toISOString(); sig.close_price = current; }
    } else {
      if (sig.tp1 && current <= sig.tp1) { sig.status = 'hit_tp1'; sig.closed_at = new Date().toISOString(); sig.close_price = current; }
      else if (sig.sl && current >= sig.sl)   { sig.status = 'hit_sl'; sig.closed_at = new Date().toISOString(); sig.close_price = current; }
    }

    if (sig.status === 'tracking' && openedAgo > maxAge) {
      sig.status = 'expired';
      sig.closed_at = new Date().toISOString();
      sig.close_price = current;
    }
  }
  saveHistory();
}
// Run every 2 minutes
setInterval(updateSignalHistory, 2 * 60 * 1000);

// ══════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════
app.get('/', (req, res) => {
  const closed = signalHistory.filter(s => s.status === 'hit_tp1' || s.status === 'hit_sl');
  const wins = closed.filter(s => s.status === 'hit_tp1').length;
  const winRate = closed.length > 0 ? Math.round((wins / closed.length) * 100) : null;

  res.json({
    status:        'SignalEdge API running',
    version:       '7.0.0',
    features:      ['multi-timeframe', 'smart-money', 'ai-signals', 'market-scan', 'alerts', 'sms', 'history'],
    signals:       signals.length,
    ai_signals:    aiSignals.length,
    market_coins:  Object.keys(marketScan.coins).length,
    market_age_s:  marketScan.updatedAt ? Math.round((Date.now() - marketScan.updatedAt) / 1000) : null,
    stats: {
      signals_today:   stats.signalsToday,
      total_signals:   stats.totalSignalsFired,
      scans_completed: stats.scanCount,
      uptime_hours:    Math.round((Date.now() - stats.startTs) / 3600000),
      subscribers:     waitlist.length,
      history_count:   signalHistory.length,
      wins, losses: closed.length - wins,
      win_rate:        winRate
    },
    integrations: {
      finnhub:   !!FINNHUB_KEY,
      onesignal: !!ONESIGNAL_API_KEY,
      twilio:    !!(TWILIO_SID && TWILIO_AUTH && TWILIO_FROM),
      persistence: DATA_READY
    }
  });
});

// ══════════════════════════════════════════
// STOCK PRICES (Finnhub proxy)
// ══════════════════════════════════════════
app.get('/api/prices', priceLimiter, async (req, res) => {
  try {
    const symbols = [
      { key:'AAPL', sym:'AAPL' }, { key:'TSLA', sym:'TSLA' }, { key:'NVDA', sym:'NVDA' },
      { key:'AMZN', sym:'AMZN' }, { key:'META', sym:'META' }, { key:'GOOGL', sym:'GOOGL' },
      { key:'SPY',  sym:'SPY'  }, { key:'QQQ',  sym:'QQQ'  }, { key:'MSFT', sym:'MSFT' },
      { key:'OANDA:EURUSD', sym:'EURUSD' }, { key:'OANDA:GBPUSD', sym:'GBPUSD' },
      { key:'OANDA:USDJPY', sym:'USDJPY' }, { key:'OANDA:AUDUSD', sym:'AUDUSD' },
      { key:'OANDA:USDCAD', sym:'USDCAD' }, { key:'OANDA:XAUUSD', sym:'XAUUSD' },
      { key:'TVC:USOIL', sym:'USOIL' }, { key:'OANDA:XAGUSD', sym:'XAGUSD' },
    ];
    if (!FINNHUB_KEY) return res.json({ error: 'Not configured', prices: {} });
    const prices = {};
    await Promise.all(symbols.map(async ({ key, sym }) => {
      try {
        if (priceCache[sym] && Date.now() - priceCache[sym].ts < 30000) {
          prices[sym] = priceCache[sym].data; return;
        }
        const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=${key}&token=${FINNHUB_KEY}`, { timeout: 5000 });
        const d = await r.json();
        if (d && d.c && d.c > 0) {
          const data = { price: d.c, change: +(d.dp || 0).toFixed(2) };
          priceCache[sym] = { data, ts: Date.now() };
          prices[sym] = data;
        }
      } catch(e) {}
    }));
    res.json({ prices, timestamp: Date.now() });
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// ══════════════════════════════════════════
// CRYPTO PRICES (CoinGecko proxy)
// ══════════════════════════════════════════
app.get('/api/crypto', priceLimiter, async (req, res) => {
  try {
    if (priceCache['_crypto'] && Date.now() - priceCache['_crypto'].ts < 30000) {
      return res.json(priceCache['_crypto'].data);
    }
    const r = await fetch(
      'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,ethereum,solana,binancecoin,ripple,cardano,dogecoin,avalanche-2&vs_currencies=usd&include_24hr_change=true',
      { timeout: 8000 }
    );
    const d = await r.json();
    const result = { prices: d, timestamp: Date.now() };
    priceCache['_crypto'] = { data: result, ts: Date.now() };
    res.json(result);
  } catch(err) {
    res.status(500).json({ error: 'Failed to fetch crypto' });
  }
});

// ══════════════════════════════════════════
// CRYPTO MARKETS TOP 200 (CoinGecko)
// Returns: symbol, name, price, 24h %, volume, marketcap, sparkline
// ══════════════════════════════════════════
app.get('/api/markets', priceLimiter, async (req, res) => {
  // Serve fresh cache (< 60s old)
  if (priceCache['_markets'] && Date.now() - priceCache['_markets'].ts < 60000) {
    return res.json(priceCache['_markets'].data);
  }
  try {
    const r = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1&sparkline=true&price_change_percentage=24h',
      { timeout: 12000 }
    );
    if (!r.ok) throw new Error(`CG ${r.status}`);
    const arr = await r.json();
    if (!Array.isArray(arr)) throw new Error('Bad CG response');
    const coins = arr.map(c => ({
      symbol:    (c.symbol || '').toUpperCase(),
      name:      c.name,
      price:     c.current_price,
      change24h: +(c.price_change_percentage_24h || 0).toFixed(2),
      volume:    c.total_volume,
      marketcap: c.market_cap,
      rank:      c.market_cap_rank,
      image:     c.image,
      sparkline: (c.sparkline_in_7d && c.sparkline_in_7d.price) ? c.sparkline_in_7d.price.filter((_,i)=>i%4===0) : []
    }));
    const result = { coins, timestamp: Date.now() };
    priceCache['_markets'] = { data: result, ts: Date.now() };
    res.json(result);
  } catch(err) {
    console.error('Markets error:', err.message);
    // ⬅️ Serve stale cache if available (even 1 hour old is better than nothing)
    if (priceCache['_markets'] && priceCache['_markets'].data) {
      console.log('[MARKETS] Serving stale cache due to CG failure');
      return res.json({ ...priceCache['_markets'].data, stale: true });
    }
    res.status(500).json({ error: 'Failed to fetch markets', coins: [] });
  }
});

// ══════════════════════════════════════════
// GET SIGNAL HISTORY
// ══════════════════════════════════════════
app.get('/api/signal-history', (req, res) => {
  res.json({ history: signalHistory.slice(0, 50), total: signalHistory.length });
});

// ══════════════════════════════════════════
// GET PERFORMANCE STATS (win rate)
// ══════════════════════════════════════════
app.get('/api/performance', (req, res) => {
  const closed = signalHistory.filter(s => s.status === 'hit_tp1' || s.status === 'hit_sl' || s.status === 'expired');
  const wins = closed.filter(s => s.status === 'hit_tp1').length;
  const losses = closed.filter(s => s.status === 'hit_sl').length;
  const expired = closed.filter(s => s.status === 'expired').length;
  const tracking = signalHistory.filter(s => s.status === 'tracking').length;
  const total = closed.length;
  const winRate = total > 0 ? Math.round((wins / total) * 100) : null;
  res.json({
    total_history: signalHistory.length,
    tracking, wins, losses, expired,
    win_rate: winRate
  });
});

// ══════════════════════════════════════════
// GET SIGNALS (Smart Money / Institutional)
// ══════════════════════════════════════════
app.get('/api/signals', (req, res) => {
  res.json(signals.slice(0, 50));
});

// ══════════════════════════════════════════
// GET AI SIGNALS
// ══════════════════════════════════════════
app.get('/api/ai-signals', (req, res) => {
  res.json(aiSignals.slice(0, 50));
});

// ══════════════════════════════════════════
// WAITLIST (email + optional phone for alerts)
// ══════════════════════════════════════════
app.post('/api/waitlist', waitlistLimiter, (req, res) => {
  try {
    const body = req.body || {};
    const email = String(body.email || '').trim().toLowerCase().substring(0, 200);
    const phone = String(body.phone || '').trim().substring(0, 30);

    // Basic email validation
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email required' });
    }

    // Dedupe — if email exists, update phone if new one given
    if (waitlistEmails.has(email)) {
      if (phone) {
        const existing = waitlist.find(w => w.email === email);
        if (existing && !existing.phone) { existing.phone = phone; saveSubscribers(); }
      }
      return res.json({ success: true, already_registered: true });
    }

    const entry = {
      email,
      phone: phone || null,
      ts: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.ip || null
    };
    waitlist.push(entry);
    waitlistEmails.add(email);
    saveSubscribers();

    console.log(`[ALERTS] +${email}${phone ? ' (+phone)' : ''} → total subscribers: ${waitlist.length}`);
    res.json({ success: true });
  } catch(err) {
    console.error('Waitlist error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Admin-only subscriber export (protected by WEBHOOK_SECRET)
app.get('/api/subscribers-export', (req, res) => {
  const auth = req.query.secret || req.headers['x-admin-secret'];
  if (!auth || auth !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ count: waitlist.length, entries: waitlist });
});

// ══════════════════════════════════════════
// GET MARKET SCAN (Real BUY/SELL/NEUTRAL tags for top 200)
// ══════════════════════════════════════════
app.get('/api/market-scan', (req, res) => {
  res.json(marketScan);
});

// ══════════════════════════════════════════
// POST MARKET SCAN (Bot uploads real tags here)
// ══════════════════════════════════════════
app.post('/webhook-scan', webhookLimiter, (req, res) => {
  try {
    const body = req.body || {};
    if (!body.secret || body.secret !== WEBHOOK_SECRET)
      return res.status(401).json({ error: 'Unauthorized' });
    if (!body.coins || typeof body.coins !== 'object')
      return res.status(400).json({ error: 'Missing coins object' });

    const cleaned = {};
    let count = 0;
    for (const [sym, data] of Object.entries(body.coins)) {
      if (count >= 250) break; // safety cap
      if (!data || typeof data !== 'object') continue;
      const signal = String(data.signal || 'hold').toLowerCase();
      if (!['buy','sell','hold'].includes(signal)) continue;
      cleaned[String(sym).toUpperCase().substring(0, 12)] = {
        signal,
        rsi:        Math.min(Math.max(parseFloat(data.rsi) || 50, 0), 100),
        vol_surge:  !!data.vol_surge,
        vol_ratio:  Math.min(Math.max(parseFloat(data.vol_ratio) || 1.0, 0), 50),
        strength:   Math.min(Math.max(parseInt(data.strength) || 0, 0), 100)
      };
      count++;
    }
    marketScan = { coins: cleaned, updatedAt: Date.now() };
    stats.scanCount++;
    console.log(`[SCAN] Market scan updated — ${count} coins (total scans: ${stats.scanCount})`);
    res.json({ success: true, count });
  } catch(err) {
    console.error('Scan webhook error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════
// INSTITUTIONAL WEBHOOK
// ══════════════════════════════════════════
app.post('/webhook', webhookLimiter, async (req, res) => {
  try {
    const body = req.body;
    if (!body.secret || body.secret !== WEBHOOK_SECRET)
      return res.status(401).json({ error: 'Unauthorized' });

    const type   = (body.type || '').toUpperCase();
    const symbol = (body.symbol || '').toUpperCase().trim();
    const price  = parseFloat(body.price) || 0;
    if (!type || !symbol || !price)
      return res.status(400).json({ error: 'Missing required fields' });

    const isBuy  = type.includes('BUY') || type.includes('LONG');
    const isSell = type.includes('SELL') || type.includes('SHORT');
    if (!isBuy && !isSell)
      return res.status(400).json({ error: 'Invalid signal type' });

    const signal = {
      id:          Date.now() + Math.floor(Math.random()*1000),
      type:        isBuy ? 'buy' : 'sell',
      symbol:      symbol.substring(0, 20),
      price,
      sl:          parseFloat(body.sl)  || 0,
      tp1:         parseFloat(body.tp1) || 0,
      tp2:         parseFloat(body.tp2) || 0,
      tp3:         parseFloat(body.tp3) || 0,
      timeframe:   (body.timeframe || '4H').substring(0, 10),
      style:       (body.style || 'swing').toString().toLowerCase().substring(0, 15),
      style_label: (body.style_label || 'Swing Trade').toString().substring(0, 30),
      hold:        (body.hold || '1–7 days').toString().substring(0, 30),
      rr:          parseFloat(body.rr) || 0,
      risk_pct:    parseFloat(body.risk_pct) || 0,
      strategy:    (body.strategy || 'SignalEdge Institutional').toString().substring(0, 50),
      time:        new Date().toISOString(),
      source:      'SignalEdge Multi-Timeframe Bot'
    };

    signals.unshift(signal);
    if (signals.length > 100) signals.pop();
    stats.totalSignalsFired++;
    stats.signalsToday++;

    // Record in history for auto-tracking
    signalHistory.unshift({
      id: signal.id,
      engine: 'smart_money',
      type: signal.type,
      symbol: signal.symbol,
      entry: signal.price,
      sl: signal.sl,
      tp1: signal.tp1,
      tp2: signal.tp2,
      tp3: signal.tp3,
      timeframe: signal.timeframe,
      style: signal.style,
      style_label: signal.style_label,
      status: 'tracking',
      opened_at: signal.time,
      closed_at: null,
      close_price: null
    });
    if (signalHistory.length > 200) signalHistory.pop();
    saveHistory();

    // SMS blast
    const smsMsg = `SignalEdge ${signal.type.toUpperCase()} ${symbol} @ ${price} | SL ${signal.sl} | TP1 ${signal.tp1}${signal.rr ? ' | RR ' + signal.rr : ''}`;
    sendSMSBlast(smsMsg).catch(()=>{});

    // Push notification
    if (ONESIGNAL_API_KEY && ONESIGNAL_APP_ID) {
      const dirEmoji = isBuy ? '🟢' : '🔴';
      const dir      = isBuy ? 'BUY' : 'SELL';
      const styleEmojis = { scalp:'⚡', day:'📊', swing:'🎯', position:'🏦' };
      const stEmoji = styleEmojis[signal.style] || '🎯';
      const title   = `${dirEmoji} ${stEmoji} ${signal.style_label} ${dir} — ${symbol}`;
      const message = `Entry: ${price} | SL: ${signal.sl || '—'} | TP1: ${signal.tp1 || '—'}${signal.rr ? ' | RR: ' + signal.rr : ''}`;
      fetch('https://onesignal.com/api/v1/notifications', {
        method:'POST',
        headers:{'Content-Type':'application/json','Authorization':`Key ${ONESIGNAL_API_KEY}`},
        body: JSON.stringify({
          app_id: ONESIGNAL_APP_ID,
          included_segments: ['All'],
          headings: { en: title },
          contents: { en: message },
          url: 'https://signaledge.guru',
          data: signal
        })
      }).catch(e => console.error('OneSignal error:', e.message));
    }

    console.log(`[INST] ${signal.type.toUpperCase()} ${symbol} @ ${price} [${signal.style}]`);
    res.json({ success: true, signal });
  } catch(err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════
// AI SIGNALS WEBHOOK
// ══════════════════════════════════════════
app.post('/webhook-ai', webhookLimiter, async (req, res) => {
  try {
    const body = req.body;
    if (!body.secret || body.secret !== WEBHOOK_SECRET)
      return res.status(401).json({ error: 'Unauthorized' });

    const type   = (body.type || '').toLowerCase();
    const symbol = (body.symbol || '').toUpperCase().trim();
    const price  = parseFloat(body.price) || 0;

    if (!type || !symbol || !price)
      return res.status(400).json({ error: 'Missing required fields' });
    if (!['buy', 'sell'].includes(type))
      return res.status(400).json({ error: 'Invalid type' });

    const tags = Array.isArray(body.tags) ? body.tags.slice(0, 5).map(t => String(t).substring(0, 20)) : [];

    // Dedup: reject if same symbol + direction fired in last 4 hours
    const dedupeWindowMs = 4 * 60 * 60 * 1000;
    const recentDuplicate = aiSignals.find(s =>
      s.symbol === symbol.substring(0, 20) &&
      s.type === type &&
      (Date.now() - new Date(s.time).getTime()) < dedupeWindowMs
    );
    if (recentDuplicate) {
      console.log(`[DEDUP] Rejected duplicate AI ${type} for ${symbol}`);
      return res.json({ success: true, deduplicated: true });
    }

    const aiSignal = {
      id:         Date.now() + Math.floor(Math.random()*1000),
      symbol:     symbol.substring(0, 20),
      type,
      price,
      entry:      parseFloat(body.entry) || price,
      sl:         parseFloat(body.sl)  || 0,
      tp1:        parseFloat(body.tp1) || 0,
      tp2:        parseFloat(body.tp2) || 0,
      confidence: Math.min(Math.max(parseInt(body.confidence) || 65, 0), 100),
      tags,
      reason:     (body.reason || '').toString().substring(0, 200),
      rsi:        parseFloat(body.rsi) || 50,
      timeframe:  (body.timeframe || '1h').substring(0, 10),
      time:       new Date().toISOString(),
      source:     'SignalEdge AI Engine'
    };

    aiSignals.unshift(aiSignal);
    if (aiSignals.length > 100) aiSignals.pop();
    stats.totalSignalsFired++;
    stats.signalsToday++;

    // Record in history (AI signals with levels only)
    if (aiSignal.sl && aiSignal.tp1) {
      signalHistory.unshift({
        id: aiSignal.id,
        engine: 'ai',
        type: aiSignal.type,
        symbol: aiSignal.symbol,
        entry: aiSignal.entry || aiSignal.price,
        sl: aiSignal.sl,
        tp1: aiSignal.tp1,
        tp2: aiSignal.tp2,
        timeframe: aiSignal.timeframe,
        confidence: aiSignal.confidence,
        status: 'tracking',
        opened_at: aiSignal.time,
        closed_at: null,
        close_price: null
      });
      if (signalHistory.length > 200) signalHistory.pop();
      saveHistory();
    }

    // SMS blast
    const smsMsg = `SignalEdge AI ${aiSignal.type.toUpperCase()} ${symbol} @ ${price} | ${aiSignal.confidence}%${aiSignal.sl ? ' | SL ' + aiSignal.sl : ''}${aiSignal.tp1 ? ' | TP1 ' + aiSignal.tp1 : ''}`;
    sendSMSBlast(smsMsg).catch(()=>{});

    console.log(`[AI] ${type.toUpperCase()} ${symbol} @ ${price} | ${aiSignal.confidence}% | ${tags.join(',')}`);
    res.json({ success: true, signal: aiSignal });
  } catch(err) {
    console.error('AI Webhook error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════
// 404 + ERROR HANDLERS
// ══════════════════════════════════════════
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ══════════════════════════════════════════
// START
// ══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SignalEdge API v7.0 running on port ${PORT}`);
  console.log(`CORS allowed origin: ${ALLOWED_ORIGIN}`);
  console.log(`Finnhub:      ${FINNHUB_KEY ? '✓' : '✗'}`);
  console.log(`OneSignal:    ${ONESIGNAL_API_KEY ? '✓' : '✗'}`);
  console.log(`Twilio SMS:   ${TWILIO_SID && TWILIO_AUTH && TWILIO_FROM ? '✓' : '✗'}`);
  console.log(`Webhook sec:  ${WEBHOOK_SECRET ? '✓' : '✗'}`);
  console.log(`Data dir:     ${DATA_READY ? '✓ ' + (fs.existsSync(DATA_DIR) ? DATA_DIR : '/tmp/signaledge-data') : '✗'}`);
  console.log(`Subscribers:  ${waitlist.length}`);
  console.log(`History:      ${signalHistory.length} signals`);

  // Preload markets cache on startup — eliminates cold-start blank state
  setTimeout(async () => {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1&sparkline=true&price_change_percentage=24h', { timeout: 12000 });
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr)) {
          const coins = arr.map(c => ({
            symbol: (c.symbol || '').toUpperCase(), name: c.name, price: c.current_price,
            change24h: +(c.price_change_percentage_24h || 0).toFixed(2), volume: c.total_volume,
            marketcap: c.market_cap, rank: c.market_cap_rank, image: c.image,
            sparkline: (c.sparkline_in_7d && c.sparkline_in_7d.price) ? c.sparkline_in_7d.price.filter((_,i)=>i%4===0) : []
          }));
          priceCache['_markets'] = { data: { coins, timestamp: Date.now() }, ts: Date.now() };
          console.log(`[STARTUP] Preloaded ${coins.length} coins into markets cache`);
        }
      }
    } catch(e) { console.warn('[STARTUP] Market preload failed:', e.message); }
  }, 2000);

  // Refresh markets cache every 90s in background so users always get fresh data
  setInterval(async () => {
    try {
      const r = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1&sparkline=true&price_change_percentage=24h', { timeout: 12000 });
      if (r.ok) {
        const arr = await r.json();
        if (Array.isArray(arr)) {
          const coins = arr.map(c => ({
            symbol: (c.symbol || '').toUpperCase(), name: c.name, price: c.current_price,
            change24h: +(c.price_change_percentage_24h || 0).toFixed(2), volume: c.total_volume,
            marketcap: c.market_cap, rank: c.market_cap_rank, image: c.image,
            sparkline: (c.sparkline_in_7d && c.sparkline_in_7d.price) ? c.sparkline_in_7d.price.filter((_,i)=>i%4===0) : []
          }));
          priceCache['_markets'] = { data: { coins, timestamp: Date.now() }, ts: Date.now() };
        }
      }
    } catch(e) {}
  }, 90000);
});
