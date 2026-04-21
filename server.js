const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const fetch        = require('node-fetch');

const app = express();

// ══════════════════════════════════════════
// ENV VARS
// ══════════════════════════════════════════
const FINNHUB_KEY       = process.env.FINNHUB_KEY;
const ONESIGNAL_APP_ID  = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET;
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN || 'https://signaledge.guru';

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
  windowMs: 15 * 60 * 1000, max: 200,
  message: { error: 'Too many requests' }
});
const priceLimiter = rateLimit({ windowMs: 60 * 1000, max: 30, message: { error: 'Rate limit' } });
const webhookLimiter = rateLimit({ windowMs: 60 * 1000, max: 300, message: { error: 'Webhook rate limit' } });

app.use(generalLimiter);

// ══════════════════════════════════════════
// IN-MEMORY STORES
// ══════════════════════════════════════════
const signals     = []; // Institutional OB signals
const aiSignals   = []; // AI (RSI/MACD/Vol/Breakout) signals
const priceCache  = {};
let   marketScan  = { coins: {}, updatedAt: 0 }; // NEW: real tags for top 200

// ══════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status:        'SignalEdge API running',
    version:       '5.0.0',
    features:      ['multi-timeframe', 'scalp', 'day', 'swing', 'position', 'ai-signals', 'market-scan'],
    signals:       signals.length,
    ai_signals:    aiSignals.length,
    market_coins:  Object.keys(marketScan.coins).length,
    market_age_s:  marketScan.updatedAt ? Math.round((Date.now() - marketScan.updatedAt) / 1000) : null
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
  try {
    if (priceCache['_markets'] && Date.now() - priceCache['_markets'].ts < 60000) {
      return res.json(priceCache['_markets'].data);
    }
    const r = await fetch(
      'https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1&sparkline=true&price_change_percentage=24h',
      { timeout: 12000 }
    );
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
    res.status(500).json({ error: 'Failed to fetch markets', coins: [] });
  }
});

// ══════════════════════════════════════════
// GET SIGNALS (Institutional)
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
// GET MARKET SCAN (Real BUY/SELL/HOLD tags for top 200)
// Returns: { coins: { BTC: {signal:'buy', rsi:32, vol_surge:true}, ... }, updatedAt }
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
        strength:   Math.min(Math.max(parseInt(data.strength) || 0, 0), 100)
      };
      count++;
    }
    marketScan = { coins: cleaned, updatedAt: Date.now() };
    console.log(`[SCAN] Market scan updated — ${count} coins`);
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

    const aiSignal = {
      id:         Date.now() + Math.floor(Math.random()*1000),
      symbol:     symbol.substring(0, 20),
      type,
      price,
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
  console.log(`SignalEdge API v5.0 running on port ${PORT}`);
  console.log(`CORS allowed origin: ${ALLOWED_ORIGIN}`);
  console.log(`Finnhub:      ${FINNHUB_KEY ? '✓' : '✗'}`);
  console.log(`OneSignal:    ${ONESIGNAL_API_KEY ? '✓' : '✗'}`);
  console.log(`Webhook sec:  ${WEBHOOK_SECRET ? '✓' : '✗'}`);
});
