const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const ONESIGNAL_APP_ID  = '1aef194a-c097-4b1c-8bb6-f8374e25f192';
const ONESIGNAL_API_KEY = process.env.ONESIGNAL_API_KEY; // set in Render env vars
const WEBHOOK_SECRET    = process.env.WEBHOOK_SECRET || 'signaledge2025';

// Store last 50 signals in memory
const signals = [];

// ── Health check
app.get('/', (req, res) => {
  res.json({ status: 'SignalEdge Webhook Server running', signals: signals.length });
});

// ── Get recent signals (for dashboard)
app.get('/signals', (req, res) => {
  res.json(signals.slice(0, 50));
});

// ── TradingView Webhook Receiver
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;

    // Optional secret check
    if (body.secret && body.secret !== WEBHOOK_SECRET) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    // Parse signal from TradingView alert message
    // Expected format from your Pine Script:
    // { "type": "BUY" or "SELL", "symbol": "BTCUSDT", "price": 84215, "sl": 83100, "tp1": 85330, "tp2": 86800, "tp3": 88215, "secret": "signaledge2025" }
    
    const type    = (body.type || body.action || '').toUpperCase();
    const symbol  = body.symbol || body.ticker || 'UNKNOWN';
    const price   = body.price  || body.close  || 0;
    const sl      = body.sl     || body.stop   || 0;
    const tp1     = body.tp1    || 0;
    const tp2     = body.tp2    || 0;
    const tp3     = body.tp3    || 0;
    const timeframe = body.timeframe || body.interval || '';

    const isBuy  = type.includes('BUY')  || type.includes('LONG');
    const isSell = type.includes('SELL') || type.includes('SHORT');

    if (!isBuy && !isSell) {
      return res.status(400).json({ error: 'Unknown signal type', received: type });
    }

    const emoji     = isBuy ? '🟢' : '🔴';
    const direction = isBuy ? 'BUY' : 'SELL';
    const tag       = isBuy ? 'buy' : 'sell';

    // Build signal object
    const signal = {
      id:        Date.now(),
      type:      tag,
      symbol,
      direction,
      price:     parseFloat(price).toFixed(5),
      sl:        parseFloat(sl).toFixed(5),
      tp1:       parseFloat(tp1).toFixed(5),
      tp2:       parseFloat(tp2).toFixed(5),
      tp3:       parseFloat(tp3).toFixed(5),
      timeframe,
      time:      new Date().toISOString(),
      source:    'Order Block & Fib Target Pro'
    };

    // Save to memory
    signals.unshift(signal);
    if (signals.length > 50) signals.pop();

    // Push notification via OneSignal
    if (ONESIGNAL_API_KEY) {
      const title   = `${emoji} ${direction} Signal — ${symbol}`;
      const message = `Entry: ${signal.price} | SL: ${signal.sl} | TP1: ${signal.tp1} | TP2: ${signal.tp2}`;

      await fetch('https://onesignal.com/api/v1/notifications', {
        method: 'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Key ${ONESIGNAL_API_KEY}`
        },
        body: JSON.stringify({
          app_id:             ONESIGNAL_APP_ID,
          included_segments:  ['All'],
          headings:           { en: title },
          contents:           { en: message },
          url:                'https://signaledge.guru',
          data: {
            signal_id: signal.id,
            type:      tag,
            symbol,
            price:     signal.price,
            sl:        signal.sl,
            tp1:       signal.tp1,
            tp2:       signal.tp2,
            tp3:       signal.tp3
          }
        })
      });
    }

    console.log(`Signal received: ${direction} ${symbol} @ ${price}`);
    res.json({ success: true, signal });

  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`SignalEdge server running on port ${PORT}`));
