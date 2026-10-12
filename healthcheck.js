const { db, getAllSubscriptions } = require('./db');
const { fetchUmZgora } = require('./umZgora');
const { fetchHtmlSources } = require('./htmlSources');
const { fetchEnea } = require('./enea');
const { fetchMzk } = require('./mzk');
const { fetchZwik } = require('./zwik');
const { fetchZdw } = require('./zdw');
const { scanItem } = require('./sanitize');
const webpush = require('web-push');

// Cotygodniowy automatyczny przeglad "zdrowia" appki. Sprawdza kazde
// zrodlo danych osobno, ile aktywnych wpisow jest w kazdej kategorii,
// ORAZ czy daty publikacji wygladaja na prawdziwe (patrz checkDateSanity
// ponizej). Wynik trafia do logow Render ORAZ jako powiadomienie push
// do subskrybenta "systemowego".
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

  const counts = db.prepare(`
    SELECT category, COUNT(*) as cnt FROM utrudnienia WHERE active = 1 GROUP BY category
  `).all();
  const categoryLine = counts.map((c) => `${c.category}: ${c.cnt}`).join(', ');
  lines.push(`📊 W bazie (aktywne): ${categoryLine || 'brak danych'}`);

  const dateSanity = checkDateSanity();
  lines.push(...dateSanity.lines);
  if (dateSanity.hasProblem) hasProblem = true;

  const textSanity = checkTextSanity();
  lines.push(...textSanity.lines);
  if (textSanity.hasProblem) hasProblem = true;

  const report = lines.join('\n');
  console.log(`[healthcheck] wynik:\n${report}`);

  await sendReportToSystemSubscribers(report, hasProblem);
  console.log('[healthcheck] koniec przegladu.');
}

// Wykrywa charakterystyczny objaw bledu "data = moment scrapowania"
// (dokladnie ten, ktory kiedys wystapil w ZDW/ZWiK/Enea): jesli w danym
// zrodle wiekszosc aktywnych wpisow ma published_at niemal identyczny z
// fetched_at (roznica ponizej godziny), to prawdopodobnie scraper znowu
// "zgaduje" date zamiast ja odczytywac z tresci, zamiast pokazywac
// prawdziwa date wydarzenia. Sprawdzamy tylko zrodla z co najmniej 3
// wpisami, zeby unikac falszywych alarmow przy bardzo malej probce.
function checkDateSanity() {
  const rows = db.prepare(`
    SELECT source_name,
      COUNT(*) as total,
      SUM(CASE WHEN ABS(strftime('%s', published_at) - strftime('%s', fetched_at)) < 3600 THEN 1 ELSE 0 END) as suspicious
    FROM utrudnienia
    WHERE active = 1
    GROUP BY source_name
    HAVING total >= 3
  `).all();

  const lines = [];
  let hasProblem = false;

  for (const row of rows) {
    const ratio = row.suspicious / row.total;
    if (ratio >= 0.7) {
      lines.push(`⚠️ ${row.source_name}: ${row.suspicious}/${row.total} wpisow ma date = czas scrapowania (mozliwy blad parsowania dat)`);
      hasProblem = true;
    }
  }

  // Dodatkowa kontrola: wpisy z data w zbyt odleglej przyszlosci (ponad
  // 120 dni) czesto oznaczaja pomylke w parsowaniu (np. zly rok).
  const futureCount = db.prepare(`
    SELECT COUNT(*) as cnt FROM utrudnienia
    WHERE active = 1 AND julianday(published_at) - julianday('now') > 120
  `).get();
  if (futureCount.cnt > 0) {
    lines.push(`⚠️ ${futureCount.cnt} wpisow ma date ponad 120 dni w przyszlosci - mozliwy blad parsowania`);
    hasProblem = true;
  }

  if (!lines.length) {
    lines.push('✅ Daty publikacji wygladaja prawidlowo we wszystkich zrodlach');
  }

  return { lines, hasProblem };
}

// Kontrola TRESCI wszystkich aktywnych wpisow - niezaleznie od tego, ktory
// scraper je wyprodukowal. Szuka sladow metadanych CMS, ktore przeciekly do
// bazy: "1 godzine temu", "Uncategorized", surowy HTML, encje, puste lub
// podejrzanie krotkie opisy. To dopelnienie filtra z sanitize.js: tam smieci
// sa obcinane na biezaco, tu wylapujemy przypadki, ktorych filtr jeszcze nie
// zna - czyli sygnal, ze strona zrodlowa zmienila uklad i trzeba dopisac
// nowa regule.
function checkTextSanity() {
  const rows = db.prepare(`
    SELECT category, source_name, title, description
    FROM utrudnienia
    WHERE active = 1
  `).all();

  const byCategory = new Map();
  let total = 0;

  for (const row of rows) {
    const problems = scanItem(row);
    if (!problems.length) continue;
    total += 1;
    const key = `${row.category} / ${row.source_name}`;
    if (!byCategory.has(key)) byCategory.set(key, new Set());
    for (const p of problems) byCategory.get(key).add(p);
  }

  const lines = [];
  if (total === 0) {
    lines.push('✅ Tresc wpisow czysta we wszystkich kategoriach');
    return { lines, hasProblem: false };
  }

  lines.push(`⚠️ ${total} wpisow ma podejrzana tresc:`);
  for (const [key, problems] of byCategory) {
    lines.push(`   • ${key}: ${[...problems].join('; ')}`);
  }
  return { lines, hasProblem: true };
}

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
