const { db, getAllSubscriptions } = require('./db');
const { fetchUmZgora } = require('./umZgora');
const { fetchHtmlSources } = require('./htmlSources');
const { fetchEnea } = require('./enea');
const { fetchMzk } = require('./mzk');
const { fetchZwik } = require('./zwik');
const { fetchZdw } = require('./zdw');
const { fetchPzzd } = require('./pzzd');
const { scanItem } = require('./sanitize');
const webpush = require('web-push');

// Cotygodniowy automatyczny przeglad "zdrowia" appki. Sprawdza kazde
// zrodlo danych osobno, ile aktywnych wpisow jest w kazdej kategorii,
// ORAZ czy daty publikacji wygladaja na prawdziwe (patrz checkDateSanity
// ponizej). Wynik trafia do logow Render ORAZ jako powiadomienie push
// do subskrybenta "systemowego".
async function runHealthCheck() {
  console.log('[healthcheck] start codziennego przegladu...');
  const lines = [];
  let hasProblem = false;

  const sources = [
    { name: 'UM Zielona Gora (RSS)', fn: fetchUmZgora },
    { name: 'ZDW', fn: fetchZdw },
    { name: 'ZWiK', fn: fetchZwik },
    { name: 'MZK', fn: fetchMzk },
    { name: 'Enea', fn: fetchEnea },
    { name: 'PZZD (drogi powiatowe)', fn: fetchPzzd },
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

  const factCoverage = checkCiekawostkaCoverage();
  lines.push(...factCoverage.lines);
  if (factCoverage.hasProblem) hasProblem = true;

  const freshness = checkSwiezoscKategorii();
  lines.push(...freshness.lines);
  if (freshness.hasProblem) hasProblem = true;

  const kodOk = checkTestyKodu();
  lines.push(...kodOk.lines);
  if (kodOk.hasProblem) hasProblem = true;

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

// Ciekawostka jest generowana w trybie "fail closed": jesli zaden z trzech
// wariantow nie przejdzie kontroli jezykowej, appka swiadomie NIE publikuje
// nic na dany dzien (uzytkownik widzi wtedy lokalna ciekawostke zapasowa).
// To bezpieczne, ale ciche - dlatego raz w tygodniu liczymy, ile dni z
// ostatnich siedmiu ma zapisana ciekawostke. Pojedynczy brak to norma,
// wiecej niz dwa oznaczaja, ze kontrola odrzuca za duzo i trzeba zajrzec
// w logi Render po konkretne komunikaty "[ciekawostka] odrzucam tekst".
function checkCiekawostkaCoverage() {
  const row = db.prepare(`
    SELECT COUNT(*) as cnt FROM daily_fact
    WHERE fact_date >= date('now', '-6 days')
  `).get();

  const lines = [];
  if (row.cnt >= 6) {
    lines.push(`✅ Ciekawostka: ${row.cnt}/7 dni z ostatniego tygodnia`);
    return { lines, hasProblem: false };
  }
  lines.push(`⚠️ Ciekawostka: tylko ${row.cnt}/7 dni - kontrola jezykowa odrzuca za duzo tekstow, sprawdz logi`);
  return { lines, hasProblem: true };
}

// Ile godzin bez nowego wpisu uznajemy za normalne. Kategorie roznia sie
// tempem: drogi i prad maja cos niemal codziennie, MZK potrafi milczec
// tygodniami, bo komunikaty komunikacji pojawiaja sie rzadziej.
const PROGI_SWIEZOSCI_H = {
  drogi: 96,
  prad: 96,
  wodociagi: 168,
  mzk: 720,
};

// Odpowiada na pytanie "czy kazda zakladka w appce ma zywa tresc".
// Sam fakt, ze scraper cos zwrocil, nie wystarcza - wpis moze byc sprzed
// pol roku, a zakladka wygladac na dzialajaca.
function checkSwiezoscKategorii() {
  const rows = db.prepare(`
    SELECT category,
           COUNT(*) AS ile,
           MAX(COALESCE(published_at, fetched_at)) AS najnowszy
    FROM utrudnienia
    WHERE active = 1 AND needs_review = 0
    GROUP BY category
  `).all();

  const lines = [];
  let hasProblem = false;
  const znalezione = new Map(rows.map((r) => [r.category, r]));

  for (const kategoria of Object.keys(PROGI_SWIEZOSCI_H)) {
    const row = znalezione.get(kategoria);
    if (!row || !row.ile) {
      lines.push(`❌ ${kategoria}: BRAK aktywnych wpisow`);
      hasProblem = true;
      continue;
    }

    const wiekH = row.najnowszy
      ? Math.round((Date.now() - new Date(row.najnowszy).getTime()) / 3600000)
      : null;
    const prog = PROGI_SWIEZOSCI_H[kategoria];

    if (wiekH === null) {
      lines.push(`⚠️ ${kategoria}: ${row.ile} wpisow, nieznana data najnowszego`);
      hasProblem = true;
    } else if (wiekH > prog) {
      lines.push(`⚠️ ${kategoria}: ${row.ile} wpisow, najnowszy sprzed ${wiekH} godz. (prog ${prog})`);
      hasProblem = true;
    } else {
      lines.push(`✅ ${kategoria}: ${row.ile} wpisow, najnowszy sprzed ${wiekH} godz.`);
    }
  }

  return { lines, hasProblem };
}

// Te same zestawy przypadkow, ktore chodza przy starcie serwera. Miedzy
// wdrozeniami kod sie nie zmienia, wiec ich codzienne uruchomienie jest
// przede wszystkim potwierdzeniem, ze wersja na serwerze jest ta, ktora
// przeszla testy - i wychwyci sytuacje, w ktorej na serwer trafil komplet
// plikow bez jednego z nich.
function checkTestyKodu() {
  try {
    const { sprawdzTresc } = require('./startupCheck');
    const { sprawdzonych, problemy } = sprawdzTresc();
    if (!problemy.length) {
      return { lines: [`✅ Testy kodu: ${sprawdzonych} przypadkow bez bledu`], hasProblem: false };
    }
    return {
      lines: [`❌ Testy kodu: ${problemy.length} bledow`, ...problemy.map((p) => `   • ${p}`)],
      hasProblem: true,
    };
  } catch (err) {
    return { lines: [`❌ Testy kodu nie wykonaly sie: ${err.message}`], hasProblem: true };
  }
}

async function sendReportToSystemSubscribers(report, hasProblem) {
  // Raport chodzi CODZIENNIE, wiec powiadomienie o tym, ze wszystko gra,
  // byloby codziennym dzwonkiem bez tresci - a po tygodniu przestaje sie
  // je czytac. Push idzie wylacznie przy problemie; pelny raport i tak
  // zawsze laduje w logach Render.
  if (!hasProblem) {
    console.log('[healthcheck] bez problemow - nie wysylam powiadomienia');
    return;
  }

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

  const title = '⚠️ Raport appki: wykryto problem';
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

module.exports = { runHealthCheck };
