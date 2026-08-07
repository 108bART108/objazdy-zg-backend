require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const {
  listUtrudnienia, db, saveSubscription, deleteSubscription,
  listActiveAds, createAd, deactivateAd, listAllAds,
} = require('./db');
const { scrapeAll } = require('./scrapeAll');
const { getTodayFact } = require('./ciekawostka');
const { notifySubscribers } = require('./push');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(
  rateLimit({
    windowMs: 60 * 1000,
    max: 60,
  })
);

function checkAdmin(req, res) {
  const adminKey = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || adminKey !== process.env.ADMIN_KEY) {
    res.status(403).json({ error: 'brak dostepu' });
    return false;
  }
  return true;
}

// --- API ---

app.get('/api/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() });
});

app.get('/api/utrudnienia', (req, res) => {
  const { category, search, limit } = req.query;
  const items = listUtrudnienia({
    category,
    search,
    limit: limit ? Number(limit) : 50,
  });
  res.json({ count: items.length, items });
});

app.get('/api/ciekawostka', async (_req, res) => {
  try {
    const fact = await getTodayFact();
    res.json(fact);
  } catch (err) {
    console.error('[ciekawostka] blad generowania:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/push/vapid-public-key', (_req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Powiadomienia push nie sa jeszcze skonfigurowane' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

app.post('/api/push/subscribe', (req, res) => {
  const { endpoint, subscription, categories } = req.body || {};
  if (!endpoint || !subscription) {
    return res.status(400).json({ error: 'brak endpoint lub subscription' });
  }
  const categoriesStr = Array.isArray(categories) ? categories.join(',') : '';
  saveSubscription(endpoint, JSON.stringify(subscription), categoriesStr);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) {
    return res.status(400).json({ error: 'brak endpoint' });
  }
  deleteSubscription(endpoint);
  res.json({ ok: true });
});

// --- Reklamy lokalnych firm ---

// Publiczny endpoint - frontend pobiera stad aktywne reklamy do wyswietlenia
app.get('/api/ads', (_req, res) => {
  res.json({ items: listActiveAds() });
});

// Dodanie nowej reklamy (chronione ADMIN_KEY)
app.post('/api/admin/ads', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { business_name, tagline, link_url } = req.body || {};
  if (!business_name || !tagline || !link_url) {
    return res.status(400).json({ error: 'wymagane: business_name, tagline, link_url' });
  }
  const id = createAd({ business_name, tagline, link_url });
  res.json({ ok: true, id });
});

// Lista wszystkich reklam (aktywnych i wylaczonych) - do podgladu w adminie
app.get('/api/admin/ads', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json({ items: listAllAds() });
});

// Wylaczenie reklamy (np. po wygasnieciu oplaty klienta)
app.post('/api/admin/ads/:id/deactivate', (req, res) => {
  if (!checkAdmin(req, res)) return;
  deactivateAd(Number(req.params.id));
  res.json({ ok: true });
});

app.post('/api/admin/refresh', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const count = await scrapeAll();
    res.json({ ok: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/test-push', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    await notifySubscribers([{
      category: 'drogi',
      street: 'Test powiadomien',
      title: 'Test powiadomien',
      description: 'To jest testowe powiadomienie z appki Utrudnienia ZG. Jesli to widzisz, wszystko dziala poprawnie!',
      source_url: 'https://objazdy-zg-frontend.onrender.com',
    }]);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`Objazdy ZG API dziala na porcie ${PORT}`);
});

cron.schedule('*/30 * * * *', () => {
  console.log('[cron] uruchamiam scrapeAll...');
  scrapeAll().catch((err) => console.error('[cron] blad:', err));
});

scrapeAll().catch((err) => console.error('[start] blad pierwszego scrapowania:', err));
