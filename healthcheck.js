const { db, getAllSubscriptions } = require('./db');
const { fetchUmZgora } = require('./umZgora');
const { fetchHtmlSources } = require('./htmlSources');
const { fetchEnea } = require('./enea');
const { fetchMzk } = require('./mzk');
const { fetchZwik } = require('./zwik');
const { fetchZdw } = require('./zdw');
const webpush = require('web-push');

// Cotygodniowy automatyczny przeglad "zdrowia" appki. Sprawdza kazde
// zrodlo danych osobno (czy w ogole cos zwraca, bez zapisywania do bazy -
// to tylko test), oraz ile aktywnych wpisow jest w kazdej kategorii w
// bazie danych. Wynik trafia do logow Render ORAZ jako powiadomienie push
// do subskrybenta "systemowego" (czyli do Ciebie, jesli sie zapiszesz -
// patrz instrukcja w komentarzu ponizej).
async function runWeeklyHealthCheck() {
  console.log('[healthcheck] start cotygodniowego przegladu...');
  const lines = [];
  let hasProblem = false;

  const sources = [
    { name: 'UM Zielona Gora (RSS)', fn: fetchUmZgora },
    { name: 'ZDW', fn: fetchZdw },
    { name: 'ZWiK', fn: fetchZwik },
    { name: 'MZK', fn: fetchMzk },
    { name: 'Enea', fn: fetchEnea },
    { name: 'htmlSources (generyczne)', fn: fetchHtmlSources },
  ];

  for (const source of sources) {
    try {
      const items = await source.fn();
      if (items.length === 0) {
        lines.push(`⚠️ ${source.name}: 0 wpisow`);
        hasProblem = true;
      } else {
        lines.push(`✅ ${source.name}: ${items.length} wpisow`);
      }
    } catch (err) {
      lines.push(`❌ ${source.name}: BLAD - ${err.message}`);
      hasProblem = true;
    }
  }

  // Liczba aktywnych wpisow w bazie, per kategoria
  const counts = db.prepare(`
    SELECT category, COUNT(*) as cnt FROM utrudnienia WHERE active = 1 GROUP BY category
  `).all();
  const categoryLine = counts.map((c) => `${c.category}: ${c.cnt}`).join(', ');
  lines.push(`📊 W bazie (aktywne): ${categoryLine || 'brak danych'}`);

  const report = lines.join('\n');
  console.log(`[healthcheck] wynik:\n${report}`);

  await sendReportToSystemSubscribers(report, hasProblem);
  console.log('[healthcheck] koniec przegladu.');
}

// Wysyla raport WYLACZNIE do subskrybentow, ktorzy jawnie zapisali sie na
// kategorie "system" (nie do zwyklych subskrybentow "wszystkich kategorii" -
// nie chcemy zasypywac zwyklych uzytkownikow technicznymi raportami).
//
// Jak sie zapisac na raporty systemowe (jednorazowo, w konsoli przegladarki,
// po wczesniejszym wlaczeniu zwyklych powiadomien w apce - potrzebujemy
// gotowej subskrypcji push):
//
//   navigator.serviceWorker.ready.then(async reg => {
//     const sub = await reg.pushManager.getSubscription();
//     await fetch('ADRES_BACKENDU/api/push/subscribe', {
//       method: 'POST',
//       headers: {'Content-Type':'application/json'},
//       body: JSON.stringify({ endpoint: sub.endpoint, subscription: sub.toJSON(), categories: ['system'] })
//     });
//   });
async function sendReportToSystemSubscribers(report, hasProblem) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    console.warn('[healthcheck] brak kluczy VAPID - nie wysylam raportu push');
    return;
  }
  webpush.setVapidDetails('mailto:kontakt@twoja-domena.pl', process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY);

  const subs = getAllSubscriptions().filter((s) => (s.categories || '').split(',').includes('system'));
  if (!subs.length) {
    console.log('[healthcheck] brak subskrybentow "system" - raport tylko w logach');
    return;
  }

  const title = hasProblem ? '⚠️ Raport appki: wykryto problem' : '✅ Raport appki: wszystko OK';
  const payload = JSON.stringify({
    title,
    body: report.slice(0, 180),
    url: 'https://objazdy-zg-frontend.onrender.com',
  });

  for (const sub of subs) {
    try {
      await webpush.sendNotification(JSON.parse(sub.subscription_json), payload);
    } catch (err) {
      console.error('[healthcheck] blad wysylki raportu:', err.statusCode || err.message);
    }
  }
}

module.exports = { runWeeklyHealthCheck };
