require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const { listUtrudnienia, db } = require('./db');
const { scrapeAll } = require('./scrapeAll');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60, // 60 zapytan / minute / IP - wystarczajace dla appki mobilnej
  })
);

// --- API ---

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

// GET /api/utrudnienia?category=drogi&search=waryńskiego&limit=50
app.get('/api/utrudnienia', (req, res) => {
  const { category, search, limit } = req.query;
  const items = listUtrudnienia({
    category,
    search,
    limit: limit ? Number(limit) : 50,
  });
  res.json({ count: items.length, items });
});

// Rejestracja subskrypcji push (uproszczone - do podpiecia pod Web Push / FCM)
app.post('/api/push/subscribe', (req, res) => {
  const { endpoint, subscription, isPremium } = req.body || {};
  if (!endpoint || !subscription) {
    return res.status(400).json({ error: 'brak endpoint lub subscription' });
  }
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, subscription_json, is_premium)
     VALUES (@endpoint, @subscription_json, @is_premium)
     ON CONFLICT(endpoint) DO UPDATE SET is_premium = @is_premium`
  ).run({
    endpoint,
    subscription_json: JSON.stringify(subscription),
    is_premium: isPremium ? 1 : 0,
  });
  res.json({ ok: true });
});

// Recznie wywolane odswiezenie danych (np. przycisk "odswiez" w adminie)
app.post('/api/admin/refresh', async (req, res) => {
  const adminKey = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'brak dostepu' });
  }
  try {
    const count = await scrapeAll();
    res.json({ ok: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Objazdy ZG API dziala na porcie ${PORT}`);
});

// --- Harmonogram scrapowania ---
// Co 30 minut, kazdego dnia. Modyfikuj wg potrzeb - utrudnienia drogowe
// nie zmieniaja sie co minute, wiec czestsze odpytywanie jest zbedne
// i tylko obciaza serwery zrodlowe.
cron.schedule('*/30 * * * *', () => {
  console.log('[cron] uruchamiam scrapeAll...');
  scrapeAll().catch((err) => console.error('[cron] blad:', err));
});

// Pierwsze pobranie danych zaraz po starcie serwera, zeby baza nie byla pusta
scrapeAll().catch((err) => console.error('[start] blad pierwszego scrapowania:', err));
