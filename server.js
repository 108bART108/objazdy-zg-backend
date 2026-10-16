require('dotenv').config();
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const {
  listUtrudnienia, db, saveSubscription, deleteSubscription,
  listActiveAds, createAd, updateAd, deactivateAd, listAllAds,
} = require('./db');
const { scrapeAll } = require('./scrapeAll');
const { getTodayFact, forceRegenerateTodayFact } = require('./ciekawostka');
const { notifySubscribers } = require('./push');
const { runWeeklyHealthCheck } = require('./healthcheck');
const { runDailyAdCheck } = require('./adReminders');

const app = express();

// Render stoi za wlasnym serwerem posredniczacym (reverse proxy).
app.set('trust proxy', 1);

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

// Wymusza usuniecie dzisiejszej ciekawostki i wygenerowanie nowej -
// przydatne, gdy dzisiejsza wersja okaze sie wadliwa.
app.post('/api/admin/ciekawostka/regenerate', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const fact = await forceRegenerateTodayFact();
    res.json(fact);
  } catch (err) {
    console.error('[ciekawostka] blad regeneracji:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// Wygodna wersja powyzszego do klikniecia z przegladarki lub telefonu -
// bez terminala i bez narzedzi developerskich. Adres z kluczem w srodku
// mozna zapisac w zakladkach. Klucz jest osobny od ADMIN_KEY (ADMIN_URL_KEY),
// bo adresy laduja w historii przegladarki i w logach serwera, wiec nie
// chcemy tam glownego klucza administracyjnego. Bez ADMIN_URL_KEY funkcja
// jest po prostu wylaczona.
// Generowanie trwa od 30 sekund do dwoch minut (szukanie faktu, weryfikacja,
// korekta, kontrola slownikiem, w razie potrzeby trzy podejscia). Przegladarka
// tyle nie czeka, dlatego praca idzie w tle, a strona odpowiada natychmiast
// i sama sie odswieza, az bedzie wynik.
let regen = { running: false, error: null, result: null, finishedAt: 0 };

// Wynik pokazujemy tylko przez 10 minut. Pozniejsze wejscie na ten sam adres
// oznacza, ze chcesz nowa ciekawostke, a nie podglad poprzedniej.
const REGEN_RESULT_TTL_MS = 10 * 60 * 1000;

function startRegen() {
  if (regen.running) return;
  regen = { running: true, error: null, result: null, finishedAt: 0 };
  forceRegenerateTodayFact()
    .then((fact) => { regen.result = fact.content; })
    .catch((err) => {
      console.error('[ciekawostka] blad regeneracji z linku:', err.message);
      regen.error = err.message;
    })
    .finally(() => {
      regen.running = false;
      regen.finishedAt = Date.now();
    });
}

app.get('/admin/nowa-ciekawostka', (req, res) => {
  const urlKey = process.env.ADMIN_URL_KEY;
  if (!urlKey) {
    return res.status(503).send(adminPage('Funkcja wylaczona', 'Nie ustawiono zmiennej ADMIN_URL_KEY w panelu Render.', 'error'));
  }
  if (req.query.klucz !== urlKey) {
    return res.status(403).send(adminPage('Brak dostepu', 'Nieprawidlowy klucz w adresie.', 'error'));
  }

  const self = `/admin/nowa-ciekawostka?klucz=${encodeURIComponent(urlKey)}`;

  if (regen.running) {
    return res.send(adminPage('Generuje nowa ciekawostke...',
      'Szukam faktu, sprawdzam zrodla i kontroluje polszczyzne. To potrwa do dwoch minut - ta strona odswiezy sie sama.',
      'working', self));
  }

  const stale = Date.now() - regen.finishedAt > REGEN_RESULT_TTL_MS;
  if (req.query.ponow === '1' || stale || (!regen.result && !regen.error)) {
    startRegen();
    return res.send(adminPage('Generuje nowa ciekawostke...',
      'Szukam faktu, sprawdzam zrodla i kontroluje polszczyzne. To potrwa do dwoch minut - ta strona odswiezy sie sama.',
      'working', self));
  }

  if (regen.error) {
    return res.send(adminPage('Nie udalo sie', regen.error, 'error', `${self}&ponow=1`));
  }

  return res.send(adminPage('Gotowe - nowa ciekawostka', regen.result, 'ok', `${self}&ponow=1`));
});

// state: 'ok' | 'error' | 'working'. Przy 'working' strona odswieza sie sama.
function adminPage(heading, body, state, link) {
  const color = state === 'ok' ? '#15803d' : state === 'error' ? '#b91c1c' : '#1d4ed8';
  const esc = (s) => String(s == null ? '' : s)
    .replace(/[<>&"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
  const refresh = state === 'working' && link
    ? `<meta http-equiv="refresh" content="8;url=${esc(link)}">`
    : '';
  const button = state === 'working'
    ? ''
    : (link ? `<a href="${esc(link)}">Wygeneruj jeszcze raz</a>` : '');
  return `<!doctype html><html lang="pl"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">${refresh}
<title>Ciekawostka - Utrudnienia ZG</title>
<style>
body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px;
background:#f8fafc;color:#0f172a;display:flex;min-height:100vh;align-items:center;justify-content:center}
.card{background:#fff;border-radius:14px;padding:28px;max-width:520px;width:100%;
box-shadow:0 1px 3px rgba(0,0,0,.1),0 8px 24px rgba(0,0,0,.06)}
h1{margin:0 0 14px;font-size:1.2rem;color:${color}}
p{margin:0 0 20px;line-height:1.6;font-size:1rem}
a{display:inline-block;padding:11px 18px;background:#0f172a;color:#fff;
text-decoration:none;border-radius:8px;font-size:.9rem}
</style></head><body><div class="card">
<h1>${esc(heading)}</h1><p>${esc(body)}</p>
${button}
</div></body></html>`;
}

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

app.get('/api/ads', (_req, res) => {
  res.json({ items: listActiveAds() });
});

// expires_at: opcjonalna data w formacie YYYY-MM-DD (pusta/brak = bezterminowa)
app.post('/api/admin/ads', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { business_name, tagline, link_url, expires_at } = req.body || {};
  if (!business_name || !tagline || !link_url) {
    return res.status(400).json({ error: 'wymagane: business_name, tagline, link_url' });
  }
  const id = createAd({ business_name, tagline, link_url, expires_at });
  res.json({ ok: true, id });
});

app.post('/api/admin/ads/:id', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { business_name, tagline, link_url, expires_at } = req.body || {};
  if (!business_name || !tagline || !link_url) {
    return res.status(400).json({ error: 'wymagane: business_name, tagline, link_url' });
  }
  updateAd(Number(req.params.id), { business_name, tagline, link_url, expires_at });
  res.json({ ok: true });
});

app.get('/api/admin/ads', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json({ items: listAllAds() });
});

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

app.post('/api/admin/healthcheck', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    await runWeeklyHealthCheck();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Recznie wywolane sprawdzenie wygasajacych/wygaslych reklam (do testow)
app.post('/api/admin/ads-check', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    await runDailyAdCheck();
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

// Cotygodniowy automatyczny przeglad zdrowia appki - niedziela 15:30 (Warszawa)
cron.schedule('30 15 * * 0', () => {
  console.log('[cron] uruchamiam cotygodniowy przeglad...');
  runWeeklyHealthCheck().catch((err) => console.error('[cron] blad przegladu:', err));
}, { timezone: 'Europe/Warsaw' });

// Codzienne sprawdzenie reklam (wygasle -> wylacz, wygasajace za <=7 dni -> przypomnienie)
// - codziennie o 8:00 czasu polskiego
cron.schedule('0 8 * * *', () => {
  console.log('[cron] uruchamiam codzienne sprawdzenie reklam...');
  runDailyAdCheck().catch((err) => console.error('[cron] blad sprawdzenia reklam:', err));
}, { timezone: 'Europe/Warsaw' });

scrapeAll().catch((err) => console.error('[start] blad pierwszego scrapowania:', err));
