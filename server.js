const express      = require('express');
const cors         = require('cors');
const helmet       = require('helmet');
const rateLimit    = require('express-rate-limit');
const fetch        = require('node-fetch');

const app = express();

// ══════════════════════════════════════════
// ENVIRONMENT VARIABLES (set in Render)
// Never hardcode keys — all stored server-side
// ══════════════════════════════════════════
const FINNHUB_KEY       = process.env.FINNHUB_KEY;
const ONESIGNAL_APP_ID  = process.env.ONESIGNAL_APP_ID;
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY;
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET;
const ALLOWED_ORIGIN    = process.env.ALLOWED_ORIGIN || 'https://signaledge.guru';

// ══════════════════════════════════════════
// SECURITY MIDDLEWARE
// ══════════════════════════════════════════

// Helmet — sets secure HTTP headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' }
}));

// CORS — only allow your domain
app.use(cors({
  origin: function(origin, callback) {
    const allowed = [
      ALLOWED_ORIGIN,
      'https://www.signaledge.guru',
      'https://deft-chimera-b83806.netlify.app',
      'http://localhost:3000' // dev only
    ];
    if (!origin || allowed.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json({ limit: '10kb' })); // limit body size

// Rate limiting — prevent abuse
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  message: { error: 'Too many requests, please try again later.' },
  standardHeaders: true,
  legacyHeaders: false,
});

const priceLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  message: { error: 'Rate limit exceeded for price data.' }
});

const webhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  message: { error: 'Webhook rate limit exceeded.' }
});

app.use(generalLimiter);

// ══════════════════════════════════════════
// IN-MEMORY STORE
// ══════════════════════════════════════════
const signals     = []; // OB signals from TradingView
const priceCache  = {}; // Cache prices to avoid hitting API limits

// ══════════════════════════════════════════
// HEALTH CHECK
// ══════════════════════════════════════════
app.get('/', (req, res) => {
  res.json({
    status:  'SignalEdge API running',
    version: '3.0.0',
    features: ['multi-timeframe', 'scalp', 'day', 'swing', 'position'],
    signals: signals.length
  });
});

// ══════════════════════════════════════════
// PRICES — Proxy for Finnhub (key never exposed)
// ══════════════════════════════════════════
app.get('/api/prices', priceLimiter, async (req, res) => {
  try {
    const symbols = [
      { key:'AAPL',           sym:'AAPL' },
      { key:'TSLA',           sym:'TSLA' },
      { key:'NVDA',           sym:'NVDA' },
      { key:'AMZN',           sym:'AMZN' },
      { key:'META',           sym:'META' },
      { key:'GOOGL',          sym:'GOOGL' },
      { key:'SPY',            sym:'SPY'  },
      { key:'QQQ',            sym:'QQQ'  },
      { key:'MSFT',           sym:'MSFT' },
      { key:'OANDA:EURUSD',   sym:'EURUSD' },
      { key:'OANDA:GBPUSD',   sym:'GBPUSD' },
      { key:'OANDA:USDJPY',   sym:'USDJPY' },
      { key:'OANDA:AUDUSD',   sym:'AUDUSD' },
      { key:'OANDA:USDCAD',   sym:'USDCAD' },
      { key:'OANDA:XAUUSD',   sym:'XAUUSD' },
      { key:'TVC:USOIL',      sym:'USOIL'  },
      { key:'OANDA:XAGUSD',   sym:'XAGUSD' },
    ];

    if (!FINNHUB_KEY) {
      return res.json({ error: 'Price service not configured', prices: {} });
    }

    const prices = {};

    await Promise.all(symbols.map(async ({ key, sym }) => {
      try {
        // Use cache if fresh (< 30 seconds old)
        if (priceCache[sym] && Date.now() - priceCache[sym].ts < 30000) {
          prices[sym] = priceCache[sym].data;
          return;
        }
        const r = await fetch(
          `https://finnhub.io/api/v1/quote?symbol=${key}&token=${FINNHUB_KEY}`,
          { timeout: 5000 }
        );
        const d = await r.json();
        if (d && d.c && d.c > 0) {
          const data = { price: d.c, change: +(d.dp || 0).toFixed(2) };
          priceCache[sym] = { data, ts: Date.now() };
          prices[sym] = data;
        }
      } catch(e) {
        // silently skip failed symbols
      }
    }));

    res.json({ prices, timestamp: Date.now() });

  } catch(err) {
    console.error('Price fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch prices' });
  }
});

// ══════════════════════════════════════════
// CRYPTO PRICES — Proxy for CoinGecko
// ══════════════════════════════════════════
app.get('/api/crypto', priceLimiter, async (req, res) => {
  try {
    // CoinGecko cache check
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
    console.error('Crypto fetch error:', err.message);
    res.status(500).json({ error: 'Failed to fetch crypto prices' });
  }
});

// ══════════════════════════════════════════
// GET SIGNALS — for frontend to display
// ══════════════════════════════════════════
app.get('/api/signals', (req, res) => {
  res.json(signals.slice(0, 50));
});

// ══════════════════════════════════════════
// TRADINGVIEW WEBHOOK — receives your signals
// ══════════════════════════════════════════
app.post('/webhook', webhookLimiter, async (req, res) => {
  try {
    const body = req.body;

    // Validate webhook secret
    if (!body.secret || body.secret !== WEBHOOK_SECRET) {
      console.warn('Unauthorized webhook attempt from:', req.ip);
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Validate required fields
    const type   = (body.type || '').toUpperCase();
    const symbol = (body.symbol || '').toUpperCase().trim();
    const price  = parseFloat(body.price) || 0;

    if (!type || !symbol || !price) {
      return res.status(400).json({ error: 'Missing required fields: type, symbol, price' });
    }

    const isBuy  = type.includes('BUY')  || type.includes('LONG');
    const isSell = type.includes('SELL') || type.includes('SHORT');

    if (!isBuy && !isSell) {
      return res.status(400).json({ error: 'Invalid signal type' });
    }

    // Sanitize inputs — v3 includes multi-timeframe fields
    const signal = {
      id:          Date.now(),
      type:        isBuy ? 'buy' : 'sell',
      symbol:      symbol.substring(0, 20),
      price:       price,
      sl:          parseFloat(body.sl)  || 0,
      tp1:         parseFloat(body.tp1) || 0,
      tp2:         parseFloat(body.tp2) || 0,
      tp3:         parseFloat(body.tp3) || 0,
      timeframe:   (body.timeframe || '4H').substring(0, 10),
      // ── Multi-timeframe fields (v3) ──
      style:       (body.style || 'swing').toString().toLowerCase().substring(0, 15),
      style_label: (body.style_label || 'Swing Trade').toString().substring(0, 30),
      hold:        (body.hold || '1–7 days').toString().substring(0, 30),
      rr:          parseFloat(body.rr)       || 0,
      risk_pct:    parseFloat(body.risk_pct) || 0,
      strategy:    (body.strategy || 'SignalEdge Institutional').toString().substring(0, 50),
      time:        new Date().toISOString(),
      source:      'SignalEdge Multi-Timeframe Bot'
    };

    // Store signal
    signals.unshift(signal);
    if (signals.length > 100) signals.pop();

    // Push notification via OneSignal
    if (ONESIGNAL_API_KEY && ONESIGNAL_APP_ID) {
      const dirEmoji = isBuy ? '🟢' : '🔴';
      const dir      = isBuy ? 'BUY' : 'SELL';
      const styleEmojis = {
        scalp:    '⚡',
        day:      '📊',
        swing:    '🎯',
        position: '🏦'
      };
      const stEmoji = styleEmojis[signal.style] || '🎯';
      const title   = `${dirEmoji} ${stEmoji} ${signal.style_label} ${dir} — ${symbol}`;
      const message = `Entry: ${price} | SL: ${signal.sl || '—'} | TP1: ${signal.tp1 || '—'}${signal.rr ? ' | RR: ' + signal.rr : ''}`;

      fetch('https://onesignal.com/api/v1/notifications', {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Key ${ONESIGNAL_API_KEY}`
        },
        body: JSON.stringify({
          app_id:            ONESIGNAL_APP_ID,
          included_segments: ['All'],
          headings:          { en: title },
          contents:          { en: message },
          url:               'https://signaledge.guru',
          data:              signal
        })
      }).catch(e => console.error('OneSignal error:', e.message));
    }

    console.log(`[SIGNAL v3] ${signal.style_label} ${signal.type.toUpperCase()} ${symbol} @ ${price} | RR ${signal.rr}`);
    res.json({ success: true, signal });

  } catch(err) {
    console.error('Webhook error:', err.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ══════════════════════════════════════════
// 404 HANDLER
// ══════════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({ error: 'Not found' });
});

// ══════════════════════════════════════════
// ERROR HANDLER
// ══════════════════════════════════════════
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err.message);
  res.status(500).json({ error: 'Internal server error' });
});

// ══════════════════════════════════════════
// START
// ══════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SignalEdge Secure API v3.0 (Multi-Timeframe) running on port ${PORT}`);
  console.log(`CORS allowed origin: ${ALLOWED_ORIGIN}`);
  console.log(`Finnhub key: ${FINNHUB_KEY ? '✓ loaded' : '✗ missing'}`);
  console.log(`OneSignal:   ${ONESIGNAL_API_KEY ? '✓ loaded' : '✗ missing'}`);
  console.log(`Webhook secret: ${WEBHOOK_SECRET ? '✓ loaded' : '✗ missing'}`);
  console.log(`Styles supported: scalp, day, swing, position`);
});
