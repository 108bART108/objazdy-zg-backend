require('dotenv').config();
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const cron = require('node-cron');

const {
  listUtrudnienia, db, saveSubscription, deleteSubscription,
  listActiveAds, createAd, updateAd, deactivateAd, listAllAds,
  listHealthReports, listSourceHealth, listSubscriptionSummary,
  checkPushSilence, getPushStats, recordPushAttempt, ensurePushLogStarted,
} = require('./db');
const { scrapeAll } = require('./scrapeAll');
const { getTodayFact, forceRegenerateTodayFact } = require('./ciekawostka');
const { notifySubscribers, sendTestNotification, checkPushConfig } = require('./push');
const { runWeeklyHealthCheck } = require('./healthcheck');
const { sendSystemAlert } = require('./systemAlerts');
const { runDailyAdCheck } = require('./adReminders');
const { runStartupCheck } = require('./startupCheck');

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

// Porownanie klucza odporne na atak czasowy. Zwykle !== przerywa na
// pierwszym roznym znaku, wiec czas odpowiedzi minimalnie zdradza, ile
// poczatkowych znakow zgadl atakujacy. Przez internet jest to praktycznie
// niewykonalne, ale timingSafeEqual nic nie kosztuje, a zamyka temat.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''), 'utf8');
  const bufB = Buffer.from(String(b || ''), 'utf8');
  // timingSafeEqual wymaga rownej dlugosci - przy roznej i tak odrzucamy,
  // bo sama dlugosc klucza nie jest tajemnica.
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function checkAdmin(req, res) {
  const adminKey = req.header('x-admin-key');
  if (!process.env.ADMIN_KEY || !safeEqual(adminKey, process.env.ADMIN_KEY)) {
    res.status(403).json({ error: 'brak dostepu' });
    return false;
  }
  return true;
}

// Adres reklamy trafia prosto do atrybutu href w appce i w panelu.
// Samo escapowanie HTML nie blokuje schematu "javascript:", dlatego
// dopuszczamy wylacznie http i https. Panel sprawdza to u siebie, ale
// API jest osobnym wejsciem i musi bronic sie samo.
function isValidAdLink(url) {
  if (typeof url !== 'string' || url.length > 500) return false;
  return /^https?:\/\/[^\s]+$/i.test(url);
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
    // Szczegoly zostaja w logach Render. Na zewnatrz idzie ogolny
    // komunikat, bo tresc bledu potrafi zdradzic sciezki na serwerze
    // albo nazwy modulow, a ten endpoint jest publiczny. Endpointy
    // administracyjne nizej celowo zwracaja pelna tresc - tam czyta ja
    // tylko ktos z kluczem, czyli Ty w panelu.
    console.error('[ciekawostka] blad generowania:', err.message);
    res.status(500).json({ error: 'nie udalo sie pobrac ciekawostki' });
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

app.get('/api/push/vapid-public-key', (_req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY) {
    return res.status(503).json({ error: 'Powiadomienia push nie sa jeszcze skonfigurowane' });
  }
  res.json({ publicKey: process.env.VAPID_PUBLIC_KEY });
});

// Znane uslugi push przegladarek. Lista sluzy WYLACZNIE do logowania -
// nie odrzucamy po niej zgloszen. Gdyby pojawila sie nowa przegladarka
// albo dostawca zmienil domene, twarda lista odcielaby prawdziwych
// uzytkownikow od powiadomien, a tego bledu nikt by nie zauwazyl.
// Zamiast tego sprawdzamy KSZTALT subskrypcji, ktory jest taki sam u
// wszystkich dostawcow - to odrzuca smieci, nie odcinajac nikogo.
const ZNANE_USLUGI_PUSH = /(^|\.)(googleapis\.com|mozilla\.com|windows\.com|apple\.com)$/i;

function sprawdzSubskrypcje(endpoint, subscription) {
  if (typeof endpoint !== 'string' || endpoint.length > 1000) return 'nieprawidlowy endpoint';

  let url;
  try {
    url = new URL(endpoint);
  } catch (err) {
    return 'endpoint nie jest adresem URL';
  }
  if (url.protocol !== 'https:') return 'endpoint musi uzywac https';

  if (!subscription || typeof subscription !== 'object') return 'brak obiektu subscription';
  if (subscription.endpoint && subscription.endpoint !== endpoint) {
    return 'endpoint nie zgadza sie z subscription.endpoint';
  }
  // Bez tych dwoch kluczy wysylka i tak jest niemozliwa - ich obecnosc
  // odroznia prawdziwa subskrypcje przegladarki od dowolnego JSON-a.
  const keys = subscription.keys;
  if (!keys || typeof keys.p256dh !== 'string' || typeof keys.auth !== 'string') {
    return 'brak kluczy szyfrujacych w subscription';
  }
  if (keys.p256dh.length > 200 || keys.auth.length > 100) return 'klucze maja nieprawidlowa dlugosc';

  if (!ZNANE_USLUGI_PUSH.test(url.hostname)) {
    console.warn(`[push] subskrypcja z nieznanej uslugi: ${url.hostname} - sprawdz, czy to nowa przegladarka, czy nadużycie`);
  }
  return null;
}

app.post('/api/push/subscribe', (req, res) => {
  const { endpoint, subscription, categories } = req.body || {};
  if (!endpoint || !subscription) {
    return res.status(400).json({ error: 'brak endpoint lub subscription' });
  }
  const problem = sprawdzSubskrypcje(endpoint, subscription);
  if (problem) {
    console.warn(`[push] odrzucono zgloszenie subskrypcji: ${problem}`);
    return res.status(400).json({ error: 'nieprawidlowa subskrypcja' });
  }

  const categoriesStr = Array.isArray(categories)
    ? categories.filter((c) => typeof c === 'string').slice(0, 20).join(',')
    : '';
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

// starts_at / expires_at: opcjonalne daty YYYY-MM-DD wyznaczajace okres emisji.
// Pusty starts_at = reklama rusza od razu, pusty expires_at = bezterminowa.
// Obie daty sa wlaczne.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateAdPeriod({ starts_at, expires_at }) {
  for (const [name, value] of [['starts_at', starts_at], ['expires_at', expires_at]]) {
    if (value && !DATE_RE.test(value)) {
      return `${name} musi byc data w formacie RRRR-MM-DD`;
    }
  }
  // Odwrocony zakres oznaczalby reklame, ktora nigdy sie nie wyswietli -
  // lepiej odrzucic go od razu, niz pozwolic zaplacic za emisje widmo.
  if (starts_at && expires_at && starts_at > expires_at) {
    return 'data rozpoczecia jest pozniejsza niz data zakonczenia';
  }
  return null;
}

app.post('/api/admin/ads', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { business_name, tagline, link_url, starts_at, expires_at } = req.body || {};
  if (!business_name || !tagline || !link_url) {
    return res.status(400).json({ error: 'wymagane: business_name, tagline, link_url' });
  }
  if (!isValidAdLink(link_url)) {
    return res.status(400).json({ error: 'link musi zaczynac sie od http:// lub https://' });
  }
  const problem = validateAdPeriod({ starts_at, expires_at });
  if (problem) return res.status(400).json({ error: problem });

  const id = createAd({ business_name, tagline, link_url, starts_at, expires_at });
  res.json({ ok: true, id });
});

app.post('/api/admin/ads/:id', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const { business_name, tagline, link_url, starts_at, expires_at } = req.body || {};
  if (!business_name || !tagline || !link_url) {
    return res.status(400).json({ error: 'wymagane: business_name, tagline, link_url' });
  }
  if (!isValidAdLink(link_url)) {
    return res.status(400).json({ error: 'link musi zaczynac sie od http:// lub https://' });
  }
  const problem = validateAdPeriod({ starts_at, expires_at });
  if (problem) return res.status(400).json({ error: problem });

  updateAd(Number(req.params.id), { business_name, tagline, link_url, starts_at, expires_at });
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

// Test powiadomien do WSZYSTKICH zapisanych urzadzen.
//
// WAZNE: wcześniej ten test udawal nowy wpis w kategorii "drogi" i szedl
// przez zwykla wysylke, ktora filtruje po kategoriach. Skutek byl mylacy:
// osoba zapisana tylko na np. MZK NIE DOSTAWALA testu, co wygladalo na
// awarie powiadomien, choc one dzialaly poprawnie. Teraz test celowo
// omija filtr kategorii i zwraca raport per urzadzenie, zeby bylo widac,
// ktore urzadzenie faktycznie przyjelo powiadomienie, a ktore odrzucilo
// i z jakim bledem.
app.post('/api/admin/test-push', async (req, res) => {
  if (!checkAdmin(req, res)) return;
  try {
    const raport = await sendTestNotification();
    res.json({ ok: true, ...raport });
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

// Kto jest zapisany na powiadomienia i na jakie kategorie - do diagnozy,
// gdy ktos zglasza, ze powiadomienia nie dochodza.
app.get('/api/admin/subscriptions', (req, res) => {
  if (!checkAdmin(req, res)) return;
  const items = listSubscriptionSummary();
  res.json({ count: items.length, items });
});

// Statystyki powiadomien - czy push faktycznie wychodzi. Pozwala
// odpowiedziec na pytanie "czy powiadomienia dzialaja?" bez czekania,
// az ktos zglosi, ze nic nie dostaje.
app.get('/api/admin/push-stats', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json(getPushStats(7));
});

// Stan zrodel danych - kiedy kazde z nich ostatnio cokolwiek zwrocilo.
app.get('/api/admin/source-health', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json({ items: listSourceHealth() });
});

// Historia cotygodniowych raportow zdrowia appki - do wyswietlenia w
// panelu admina, zamiast grzebania w logach Render.
app.get('/api/admin/health-reports', (req, res) => {
  if (!checkAdmin(req, res)) return;
  res.json({ items: listHealthReports() });
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

// Codzienne przygotowanie ciekawostki Z WYPRZEDZENIEM, wczesnym rankiem
// (5:30 czasu polskiego) - zanim ktokolwiek otworzy appke. getTodayFact()
// samo sprawdza cache (tabela daily_fact) i generuje nowa tresc tylko
// jesli jeszcze jej nie ma, wiec to bezpieczne w wywolaniu takze wtedy,
// gdyby z jakiegos powodu ciekawostka na dzis juz istniala. Dzieki temu
// pierwszy uzytkownik dnia, ktory otworzy zakladke Ciekawostka, dostaje
// juz gotowa, zapisana w bazie tresc - dokladnie tak szybko jak pozostale
// kategorie - zamiast czekac na dwuetapowe (generowanie + recenzja)
// zapytanie do Claude z wyszukiwaniem w internecie na zywo.
cron.schedule('30 5 * * *', () => {
  console.log('[cron] przygotowuje dzisiejsza ciekawostke z wyprzedzeniem...');
  getTodayFact({ wait: true }).catch((err) => console.error('[cron] blad przygotowania ciekawostki:', err.message));
}, { timezone: 'Europe/Warsaw' });

app.listen(PORT, () => {
  console.log(`Objazdy ZG API dziala na porcie ${PORT}`);
  // Sprawdzenie konfiguracji powiadomien zaraz po starcie - literowka w
  // adresie appki albo niewypelniony wzorzec w kontakcie VAPID sa widoczne
  // od razu w logach wdrozenia, zamiast lezec niezauwazone miesiacami.
  // Czy wszystkie wgrane pliki sa z tej samej wersji. Niespojne wdrozenie
  // (np. nowy scrapeAll.js przy starym db.js) potrafi zatrzymac zapisywanie
  // nowych wpisow na wiele godzin, dajac o sobie znac tylko bledem w logach.
  runStartupCheck();
  checkPushConfig();
  // Zaklada znacznik poczatku zbierania danych o powiadomieniach, zeby
  // statystyki nie pokazywaly swiezego dziennika jako "zero wyslanych".
  try { ensurePushLogStarted(); } catch (err) { console.error('[start] nie udalo sie zalozyc dziennika push:', err.message); }
});

// Scrapowanie co 10 minut zamiast co 30 - zrodla sa sprawdzane znacznie
// czesciej, wiec nowy komunikat (np. objazd na Wszystkich Swietych) trafia
// do appki w ciagu kilkunastu minut, a nie po godzinie.
//
// KOSZT: zero. Scrapowanie to zwykle pobranie stron HTTP z serwera, ktory
// i tak dziala 24/7 w stalej cenie - nie ma tu zadnego platnego API.
// Jedyne platne wywolania (Anthropic) dotycza ciekawostki i maja wlasny
// twardy limit 3 na dobe, calkowicie niezalezny od tego harmonogramu.
// Ile cykli scrapowania moze padnac z rzedu, zanim dostaniesz alert.
// 3 cykle to ok. 30 minut - na tyle dlugo, by nie alarmowac przy
// chwilowej awarii sieci, i na tyle krotko, by nie dowiedziec sie o
// zatrzymanej appce po godzinach.
const SCRAPE_FAILS_BEFORE_ALERT = 3;
let kolejneBledyScrapowania = 0;
let zglosonoAwarieScrapowania = false;

cron.schedule('*/10 * * * *', async () => {
  console.log('[cron] uruchamiam scrapeAll...');
  try {
    await scrapeAll();
    if (kolejneBledyScrapowania >= SCRAPE_FAILS_BEFORE_ALERT) {
      console.log('[cron] scrapowanie znowu dziala');
      sendSystemAlert('Scrapowanie znowu dziala', 'Appka wrocila do zapisywania nowych wpisow.')
        .catch(() => { /* alert jest dodatkiem, nie moze przerwac pracy */ });
    }
    kolejneBledyScrapowania = 0;
    zglosonoAwarieScrapowania = false;
  } catch (err) {
    kolejneBledyScrapowania++;
    console.error(`[cron] blad (${kolejneBledyScrapowania}. raz z rzedu):`, err);

    // Padajace scrapowanie oznacza, ze do appki NIE TRAFIAJA nowe wpisy -
    // objaw gorszy niz brak jednego zrodla, bo dotyczy wszystkich kategorii
    // naraz. Wczesniej jedynym sladem byl blad w logach Render.
    if (kolejneBledyScrapowania >= SCRAPE_FAILS_BEFORE_ALERT && !zglosonoAwarieScrapowania) {
      zglosonoAwarieScrapowania = true;
      sendSystemAlert(
        'Appka nie zapisuje nowych wpisow',
        `Scrapowanie padlo ${kolejneBledyScrapowania} razy z rzedu: ${err.message}. Sprawdz logi Render.`
      ).catch(() => { /* jw. */ });
    }
  }
});

// Codzienne sprawdzenie, czy powiadomienia faktycznie wychodza.
//
// To zabezpieczenie przed cicha awaria: jesli do appki trafiaja nowe
// wpisy, a nie wychodzi ani jedno powiadomienie, dostaniesz o tym alert
// zamiast dowiadywac sie od uzytkownikow po kilku tygodniach. Sprawdzenie
// to pare zapytan do lokalnej bazy - zero kosztu.
cron.schedule('0 9 * * *', async () => {
  try {
    const stan = checkPushSilence();
    if (!stan.cisza) {
      console.log(`[cron] kontrola push OK (${stan.wyslane} powiadomien / ${stan.noweWpisy} nowych wpisow w 7 dni)`);
      return;
    }
    console.error('[cron] ALARM - powiadomienia milcza:', stan.powod);
    recordPushAttempt({ kind: 'alarm', szczegoly: stan.powod });
    await sendSystemAlert('Powiadomienia nie wychodza', stan.powod);
  } catch (err) {
    console.error('[cron] blad kontroli powiadomien:', err.message);
  }
}, { timezone: 'Europe/Warsaw' });

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
getTodayFact({ wait: true }).catch((err) => console.error('[start] blad przygotowania ciekawostki:', err.message));
