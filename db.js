const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'objazdy.db');

require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS utrudnienia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT UNIQUE NOT NULL,
    source_name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'drogi',
    title TEXT NOT NULL,
    street TEXT,
    description TEXT,
    published_at TEXT,
    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_utrudnienia_category ON utrudnienia(category);
  CREATE INDEX IF NOT EXISTS idx_utrudnienia_published ON utrudnienia(published_at DESC);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    subscription_json TEXT NOT NULL,
    categories TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS daily_fact (
    fact_date TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS local_ads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    tagline TEXT NOT NULL,
    link_url TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Stan kazdego zrodla danych. Dzieki temu wiemy, ze np. MZK od dwoch dni
  -- nie zwraca ani jednego wpisu - appka wyglada wtedy normalnie, wiec bez
  -- takiego zapisu problem potrafi zostac niezauwazony przez wiele dni.
  CREATE TABLE IF NOT EXISTS source_health (
    source TEXT PRIMARY KEY,
    last_count INTEGER NOT NULL DEFAULT 0,
    empty_streak INTEGER NOT NULL DEFAULT 0,
    last_ok_at TEXT,
    alerted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Dziennik kazdej proby wysylki powiadomien. Bez tego nie da sie
  -- stwierdzic "push nie dziala od tygodnia" - a wlasnie tak przebiegla
  -- awaria, przy ktorej wpisy pojawialy sie w appce, powiadomienia nie
  -- wychodzily, i nikt sie o tym nie dowiedzial, bo system nie krzyczal.
  -- kind: 'wysylka' (wynik cyklu) albo 'alarm' (zgloszono cisze push).
  CREATE TABLE IF NOT EXISTS push_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'wysylka',
    kandydatow INTEGER NOT NULL DEFAULT 0,
    dostarczono INTEGER NOT NULL DEFAULT 0,
    bledow INTEGER NOT NULL DEFAULT 0,
    pominieto_stare INTEGER NOT NULL DEFAULT 0,
    pominieto_kategorie INTEGER NOT NULL DEFAULT 0,
    szczegoly TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS health_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report TEXT NOT NULL,
    has_problem INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`);

const migrations = [
  'ALTER TABLE local_ads ADD COLUMN expires_at TEXT',
  'ALTER TABLE local_ads ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE utrudnienia ADD COLUMN event_date TEXT',
  'ALTER TABLE utrudnienia ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE utrudnienia ADD COLUMN review_reasons TEXT',
  'ALTER TABLE daily_fact ADD COLUMN source_url TEXT',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (err) { /* kolumna juz istnieje */ }
}

// Jednorazowe naprawienie juz istniejacych wpisow, ktore zdazyly zapisac
// sie z bledna, przyszla data (np. zaplanowana godzina wylaczenia pradu)
// jako published_at - zanim wprowadzilismy sanitizePublishedAt(). Mechanizm
// "samoleczacy" (COALESCE) sam z siebie by tego NIE naprawil, bo dla tych
// wpisow zawsze bedzie brakowac nowej, pewnej daty (Enea zawsze podaje
// date zdarzenia w przyszlosci) - wiec bez tej jednorazowej korekty stara,
// bledna wartosc zostalaby zachowana w nieskonczonosc.
try {
  const fixed = db.prepare(`
    UPDATE utrudnienia
    SET published_at = fetched_at
    WHERE published_at IS NOT NULL
      AND julianday(published_at) - julianday('now') > 1
  `).run();
  if (fixed.changes > 0) {
    console.log(`[db] naprawiono ${fixed.changes} wpisow z blednie zapisana data w przyszlosci`);
  }
} catch (err) {
  console.error('[db] blad jednorazowej naprawy dat:', err.message);
}

// Jednorazowe posprzatanie juz istniejacych duplikatow tresci (ten sam
// tytul+opis w tej samej kategorii zapisany jako dwa osobne wiersze -
// zwykle efekt tego, ze zrodlo publikuje ten sam komunikat dwa razy
// z drobna, niewidoczna roznica w otaczajacym tekscie, przez co dwa
// wpisy dostaly rozne source_url/hash). Zostaje wpis z najnizszym id
// (czyli odkryty jako pierwszy), reszta zostaje dezaktywowana (nie
// usuwana - zeby nie stracic historii/source_url na wszelki wypadek).
try {
  const normalize = (t) => (t || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:…]+$/, '').trim();
  const rows = db.prepare('SELECT id, category, title, description FROM utrudnienia WHERE active = 1').all();
  const seen = new Map();
  const duplicateIds = [];
  for (const row of rows) {
    const key = `${row.category}||${normalize(row.title)}||${normalize(row.description)}`;
    if (seen.has(key)) {
      duplicateIds.push(row.id);
    } else {
      seen.set(key, row.id);
    }
  }
  if (duplicateIds.length) {
    const placeholders = duplicateIds.map(() => '?').join(',');
    db.prepare(`UPDATE utrudnienia SET active = 0 WHERE id IN (${placeholders})`).run(...duplicateIds);
    console.log(`[db] zdezaktywowano ${duplicateIds.length} zdublowanych wpisow (ta sama tresc, rozne source_url)`);
  }
} catch (err) {
  console.error('[db] blad jednorazowego sprzatania duplikatow:', err.message);
}

// WAZNE: published_at uzywa COALESCE w dwoch miejscach - to jest mechanizm
// "samoleczacy" zapobiegajacy powrotowi bledu "data = moment scrapowania":
//  - Przy NOWYM wpisie (INSERT): jesli scraper nie podal pewnej daty
//    (published_at = null), uzywamy biezacej daty jako jedynego rozsadnego
//    przyblizenia (pierwszy raz widzimy ten wpis, wiec to najlepsze co
//    mamy).
//  - Przy JUZ ISTNIEJACYM wpisie (UPDATE): jesli scraper w tym przebiegu
//    NIE podal pewnej daty, zachowujemy date, ktora JUZ byla zapisana w
//    bazie, zamiast ja nadpisywac domyslnym "teraz". Dzieki temu nawet
//    jesli parsowanie daty w ktoryms scraperze znowu kiedys zawiedzie,
//    appka nie zacznie znowu pokazywac wszystkim wpisom dzisiejszej daty -
//    po prostu zachowa ostatnia znana, dobra wartosc.
const upsertStmt = db.prepare(`
  INSERT INTO utrudnienia (source_url, source_name, category, title, street, description, published_at, event_date, needs_review, review_reasons)
  VALUES (@source_url, @source_name, @category, @title, @street, @description, COALESCE(@published_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), @event_date, @needs_review, @review_reasons)
  ON CONFLICT(source_url) DO UPDATE SET
    title = excluded.title,
    street = excluded.street,
    description = excluded.description,
    published_at = COALESCE(@published_at, utrudnienia.published_at),
    event_date = COALESCE(@event_date, utrudnienia.event_date),
    needs_review = excluded.needs_review,
    review_reasons = excluded.review_reasons,
    active = 1
`);

const existsStmt = db.prepare('SELECT 1 FROM utrudnienia WHERE source_url = ?');

// Data w przyszlosci (ponad dobe od teraz) NIE jest uzywana jako
// published_at. Taka data zazwyczaj oznacza zaplanowane, jednorazowe
// wydarzenie (np. godzina planowanego wylaczenia pradu w przyszlym
// tygodniu), a nie faktyczna date publikacji/odkrycia informacji przez
// nasz system. W takim przypadku karta w appce ma pokazywac date
// DZISIEJSZA (kiedy dowiedzielismy sie o tym wydarzeniu) - a szczegoly
// czasowe samego wydarzenia i tak zostaja w opisie tekstowym wpisu.
// Dziala to jednolicie dla wszystkich zrodel, bez potrzeby osobnej
// logiki w kazdym scraperze.
function sanitizePublishedAt(publishedAt) {
  if (!publishedAt) return null;
  const parsed = new Date(publishedAt);
  if (isNaN(parsed.getTime())) return null;
  const oneDayFromNow = Date.now() + 86400000;
  if (parsed.getTime() > oneDayFromNow) return null;
  return publishedAt;
}

function upsertMany(items) {
  const newItems = [];
  const flaggedItems = [];
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const alreadyExists = existsStmt.get(row.source_url);
      if (!alreadyExists) newItems.push(row);
      if (row.needs_review) flaggedItems.push(row);
      upsertStmt.run({
        ...row,
        published_at: sanitizePublishedAt(row.published_at),
        event_date: row.event_date || null,
        needs_review: row.needs_review ? 1 : 0,
        review_reasons: row.review_reasons ? row.review_reasons.join('; ') : null,
      });
    }
  });
  tx(items);
  return { count: items.length, newItems, flaggedItems };
}

function listUtrudnienia({ category, search, limit = 50 } = {}) {
  // needs_review = 0: appka pokazuje tylko wpisy, ktore przeszly
  // automatyczne sprawdzenie jakosci (qualityCheck) bez zastrzezen.
  // Nie ma tu zadnego recznego kroku - wpis albo przechodzi test przy
  // scrapowaniu, albo czeka na kolejny cykl, w ktorym scraper moze
  // wyciagnac lepsza tresc (np. po naprawieniu ekstrakcji zrodla).
  let query = 'SELECT * FROM utrudnienia WHERE active = 1 AND needs_review = 0';
  const params = {};

  if (category && category !== 'all') {
    query += ' AND category = @category';
    params.category = category;
  }
  if (search) {
    query += ' AND (title LIKE @search OR street LIKE @search OR description LIKE @search)';
    params.search = `%${search}%`;
  }
  // Sortowanie: ZAWSZE od najnowiej opublikowanego wpisu do najstarszego,
  // niezaleznie od tego czy wpis ma zaplanowana przyszla event_date.
  // event_date sluzy WYLACZNIE do wyswietlenia zoltej plakietki
  // "Dzisiaj/Jutro/za X dni" na karcie - nie zmienia kolejnosci listy.
  // (Wczesniej wpisy z przyszla event_date szly na sam gore, co przy
  // bledzie parsowania daty potrafilo wywindowac stary wpis ponad nowsze
  // - stąd ta zmiana.)
  query += ' ORDER BY published_at DESC LIMIT @limit';
  params.limit = limit;

  return db.prepare(query).all(params);
}

function getDailyFact(date) {
  return db.prepare('SELECT * FROM daily_fact WHERE fact_date = ?').get(date);
}

function deleteDailyFact(date) {
  db.prepare('DELETE FROM daily_fact WHERE fact_date = ?').run(date);
}

// sourceUrl - zweryfikowany link do zrodla ciekawostki (moze byc null
// dla starszych wpisow sprzed wprowadzenia zrodel).
function saveDailyFact(date, content, sourceUrl = null) {
  db.prepare(`
    INSERT INTO daily_fact (fact_date, content, source_url) VALUES (@date, @content, @sourceUrl)
    ON CONFLICT(fact_date) DO UPDATE SET content = excluded.content, source_url = excluded.source_url
  `).run({ date, content, sourceUrl });
}

function getRecentFacts(limit = 20) {
  return db.prepare('SELECT content FROM daily_fact ORDER BY fact_date DESC LIMIT ?')
    .all(limit)
    .map((r) => r.content);
}

// Najnowsza zapisana ciekawostka (niezaleznie od daty). Sluzy do tego, by
// przy braku dzisiejszej tresci pokazac uzytkownikowi od reki wczorajsza,
// zamiast kazac mu czekac na wygenerowanie nowej.
// Zapisuje wynik jednego cyklu dla danego zrodla i zwraca jego stan:
// ile cykli z rzedu bylo pustych i czy wyslano juz o tym alert.
function recordSourceResult(source, count) {
  const previous = db.prepare('SELECT * FROM source_health WHERE source = ?').get(source);
  const emptyStreak = count > 0 ? 0 : (previous ? previous.empty_streak : 0) + 1;
  const alerted = count > 0 ? 0 : (previous ? previous.alerted : 0);
  const lastOkAt = count > 0 ? new Date().toISOString() : (previous ? previous.last_ok_at : null);

  db.prepare(`
    INSERT INTO source_health (source, last_count, empty_streak, last_ok_at, alerted, updated_at)
    VALUES (@source, @count, @emptyStreak, @lastOkAt, @alerted, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(source) DO UPDATE SET
      last_count = excluded.last_count,
      empty_streak = excluded.empty_streak,
      last_ok_at = excluded.last_ok_at,
      alerted = excluded.alerted,
      updated_at = excluded.updated_at
  `).run({ source, count, emptyStreak, lastOkAt, alerted });

  return {
    emptyStreak,
    alreadyAlerted: !!alerted,
    lastOkAt,
    wasBroken: !!(previous && previous.alerted),
  };
}

// Oznacza, ze alert o tym zrodle zostal juz wyslany - zeby nie powtarzac
// go przy kazdym cyklu scrapowania.
function markSourceAlerted(source) {
  db.prepare('UPDATE source_health SET alerted = 1 WHERE source = ?').run(source);
}

function listSourceHealth() {
  return db.prepare('SELECT * FROM source_health ORDER BY source').all();
}

// --- Dziennik powiadomien push ---

function recordPushAttempt(dane) {
  db.prepare(`
    INSERT INTO push_log (kind, kandydatow, dostarczono, bledow, pominieto_stare, pominieto_kategorie, szczegoly)
    VALUES (@kind, @kandydatow, @dostarczono, @bledow, @pominietoStare, @pominietoKategorie, @szczegoly)
  `).run({
    kind: dane.kind || 'wysylka',
    kandydatow: dane.kandydatow || 0,
    dostarczono: dane.dostarczono || 0,
    bledow: dane.bledow || 0,
    pominietoStare: dane.pominietoStare || 0,
    pominietoKategorie: dane.pominietoKategorie || 0,
    szczegoly: dane.szczegoly || null,
  });
}

// Sprawdza, czy appka nie "zamilkla": czy do bazy trafiaja nowe wpisy,
// a jednoczesnie nie wychodzi ANI JEDNO powiadomienie.
//
// To test objawu, nie konkretnej przyczyny - i o to chodzi. Awaria, ktora
// to wywolala, wynikala ze zbyt waskiego filtra swiezosci, ale dokladnie
// tak samo wygladalaby przy braku kluczy VAPID, bledzie w kodzie wysylki,
// czy gdyby wszyscy sie wypisali. Kazdy z tych przypadkow zostanie tu
// wychwycony, takze taki, ktorego dzisiaj nie przewidujemy.
const PUSH_SILENCE_DAYS = 7;
const PUSH_SILENCE_MIN_ITEMS = 5;
const PUSH_ALARM_COOLDOWN_DAYS = 7;

// Od kiedy dziennik push w ogole zbiera dane. Bez tego statystyki
// porownywalyby wpisy z 7 dni z dziennikiem zalozonym godzine temu i
// pokazywaly "0 wyslanych powiadomien" jako awarie, choc to tylko brak
// historii. Znacznik zakladany jest przy pierwszym starcie po wdrozeniu.
function ensurePushLogStarted() {
  const istnieje = db.prepare('SELECT 1 FROM push_log LIMIT 1').get();
  if (!istnieje) {
    db.prepare("INSERT INTO push_log (kind, szczegoly) VALUES ('start', 'poczatek zbierania danych o powiadomieniach')").run();
  }
}

function getPushLogStart() {
  const r = db.prepare('SELECT created_at FROM push_log ORDER BY id ASC LIMIT 1').get();
  return r ? r.created_at : null;
}

// Czy dziennik zbiera dane wystarczajaco dlugo, by jego cisza cokolwiek
// znaczyla.
function pushLogDojrzaly(dni) {
  const start = getPushLogStart();
  if (!start) return false;
  const wiek = Date.now() - new Date(start).getTime();
  return wiek >= dni * 86400000;
}

function checkPushSilence() {
  const od = new Date(Date.now() - PUSH_SILENCE_DAYS * 86400000).toISOString();

  const noweWpisy = db.prepare(
    'SELECT COUNT(*) AS n FROM utrudnienia WHERE fetched_at >= ?'
  ).get(od).n;

  const wyslane = db.prepare(
    "SELECT COALESCE(SUM(dostarczono), 0) AS n FROM push_log WHERE kind = 'wysylka' AND created_at >= ?"
  ).get(od).n;

  const subskrybenci = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;

  const stan = { noweWpisy, wyslane, subskrybenci, cisza: false, powod: null };

  // Swiezo zalozony dziennik nie moze byc dowodem na awarie - przez
  // pierwsze dni po wdrozeniu po prostu nie ma jeszcze z czym porownywac.
  if (!pushLogDojrzaly(PUSH_SILENCE_DAYS)) return stan;

  // Bez zapisanych urzadzen cisza jest poprawna - nie ma do kogo wysylac.
  if (!subskrybenci) return stan;
  if (noweWpisy < PUSH_SILENCE_MIN_ITEMS) return stan;
  if (wyslane > 0) return stan;

  // Nie powtarzamy tego samego alarmu codziennie.
  const ostatniAlarm = db.prepare(
    "SELECT created_at FROM push_log WHERE kind = 'alarm' ORDER BY id DESC LIMIT 1"
  ).get();
  if (ostatniAlarm) {
    const wiek = Date.now() - new Date(ostatniAlarm.created_at).getTime();
    if (wiek < PUSH_ALARM_COOLDOWN_DAYS * 86400000) return stan;
  }

  stan.cisza = true;
  stan.powod = `W ciagu ${PUSH_SILENCE_DAYS} dni do appki trafilo ${noweWpisy} nowych wpisow, `
    + `ale nie wyszlo ani jedno powiadomienie (${subskrybenci} zapisanych urzadzen).`;
  return stan;
}

// Podsumowanie dla panelu admina: ile powiadomien wyszlo w ostatnich dniach.
function getPushStats(days = 7) {
  const start = getPushLogStart();
  const oknoOd = new Date(Date.now() - days * 86400000);
  // Jesli dziennik jest mlodszy niz zadane okno, liczymy od jego zalozenia
  // - inaczej porownywalibysmy wpisy z 7 dni z wysylkami z jednego dnia.
  const dziennikMlodszy = start && new Date(start).getTime() > oknoOd.getTime();
  const od = dziennikMlodszy ? start : oknoOd.toISOString();
  const w = db.prepare(`
    SELECT COALESCE(SUM(dostarczono), 0) AS dostarczono,
           COALESCE(SUM(bledow), 0) AS bledow,
           COALESCE(SUM(pominieto_stare), 0) AS pominietoStare,
           COUNT(*) AS cykli
    FROM push_log WHERE kind = 'wysylka' AND created_at >= ?
  `).get(od);
  const noweWpisy = db.prepare('SELECT COUNT(*) AS n FROM utrudnienia WHERE fetched_at >= ?').get(od).n;
  const ostatnia = db.prepare(
    "SELECT created_at FROM push_log WHERE kind = 'wysylka' AND dostarczono > 0 ORDER BY id DESC LIMIT 1"
  ).get();
  return {
    dni: days,
    zbieraOd: start,
    pelneDane: !dziennikMlodszy,
    noweWpisy,
    dostarczono: w.dostarczono,
    bledow: w.bledow,
    pominietoStare: w.pominietoStare,
    cykliWysylki: w.cykli,
    ostatniaUdanaWysylka: ostatnia ? ostatnia.created_at : null,
    subskrybenci: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n,
  };
}

function getLatestFact() {
  return db.prepare('SELECT * FROM daily_fact ORDER BY fact_date DESC LIMIT 1').get();
}

function saveSubscription(endpoint, subscriptionJson, categories) {
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, subscription_json, categories)
    VALUES (@endpoint, @subscription_json, @categories)
    ON CONFLICT(endpoint) DO UPDATE SET
      subscription_json = excluded.subscription_json,
      categories = excluded.categories
  `).run({ endpoint, subscription_json: subscriptionJson, categories });
}

function deleteSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

function getAllSubscriptions() {
  return db.prepare('SELECT * FROM push_subscriptions').all();
}

// Podsumowanie subskrypcji powiadomien - do diagnozy w panelu admina.
// NIE zwraca pelnych adresow endpointow (to identyfikatory konkretnych
// urzadzen) - tylko dostawce, kategorie i date zapisu. To wystarczy, by
// stwierdzic, czy ktos sie w ogole zapisal i na jakie kategorie.
function listSubscriptionSummary() {
  const rows = db.prepare('SELECT endpoint, categories, created_at FROM push_subscriptions ORDER BY created_at DESC').all();
  return rows.map((r) => {
    let dostawca = 'nieznany';
    try {
      const host = new URL(r.endpoint).hostname;
      if (host.includes('fcm.googleapis') || host.includes('android')) dostawca = 'Android / Chrome';
      else if (host.includes('push.apple')) dostawca = 'Apple (iPhone)';
      else if (host.includes('mozilla')) dostawca = 'Firefox';
      else if (host.includes('windows') || host.includes('notify')) dostawca = 'Windows / Edge';
      else dostawca = host;
    } catch { /* zostawiamy "nieznany" */ }
    return {
      dostawca,
      // Pusta lista kategorii oznacza "wszystkie" - tak to traktuje
      // notifySubscribers w push.js. Wczesniej panel opisywal to jako
      // "nie dostanie nic", czyli dokladnie odwrotnie niz dziala kod.
      kategorie: r.categories || '(wszystkie)',
      zapisano: r.created_at,
      // kilka ostatnich znakow, zeby rozroznic urzadzenia bez ujawniania adresu
      id: r.endpoint.slice(-8),
    };
  });
}

function listActiveAds() {
  return db.prepare(`
    SELECT * FROM local_ads
    WHERE active = 1 AND (expires_at IS NULL OR expires_at = '' OR date(expires_at) >= date('now'))
    ORDER BY id DESC
  `).all();
}

function createAd({ business_name, tagline, link_url, expires_at }) {
  const info = db.prepare(`
    INSERT INTO local_ads (business_name, tagline, link_url, expires_at)
    VALUES (@business_name, @tagline, @link_url, @expires_at)
  `).run({ business_name, tagline, link_url, expires_at: expires_at || null });
  return info.lastInsertRowid;
}

function updateAd(id, { business_name, tagline, link_url, expires_at }) {
  db.prepare(`
    UPDATE local_ads
    SET business_name = @business_name,
        tagline = @tagline,
        link_url = @link_url,
        expires_at = @expires_at,
        reminder_sent = 0
    WHERE id = @id
  `).run({ id, business_name, tagline, link_url, expires_at: expires_at || null });
}

function deactivateAd(id) {
  db.prepare('UPDATE local_ads SET active = 0 WHERE id = ?').run(id);
}

function listAllAds() {
  return db.prepare('SELECT * FROM local_ads ORDER BY id DESC').all();
}

function deactivateExpiredAds() {
  const expired = db.prepare(`
    SELECT * FROM local_ads
    WHERE active = 1 AND expires_at IS NOT NULL AND expires_at != '' AND date(expires_at) < date('now')
  `).all();
  if (expired.length) {
    const ids = expired.map((a) => a.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE local_ads SET active = 0 WHERE id IN (${placeholders})`).run(...ids);
  }
  return expired;
}

function getAdsNeedingReminder() {
  return db.prepare(`
    SELECT * FROM local_ads
    WHERE active = 1
      AND expires_at IS NOT NULL AND expires_at != ''
      AND reminder_sent = 0
      AND date(expires_at) <= date('now', '+7 days')
      AND date(expires_at) >= date('now')
  `).all();
}

function markReminderSent(id) {
  db.prepare('UPDATE local_ads SET reminder_sent = 1 WHERE id = ?').run(id);
}

// Zapisuje cotygodniowy raport zdrowia appki, zeby mozna go bylo pozniej
// przejrzec w panelu admina zamiast grzebac w logach Render. Trzyma tylko
// ostatnie 50 raportow (ok. rok przy cotygodniowym cyklu) - usuwa starsze
// przy kazdym zapisie, zeby tabela nie rosla bez konca.
function saveHealthReport(report, hasProblem) {
  db.prepare(`
    INSERT INTO health_reports (report, has_problem) VALUES (?, ?)
  `).run(report, hasProblem ? 1 : 0);
  db.prepare(`
    DELETE FROM health_reports WHERE id NOT IN (
      SELECT id FROM health_reports ORDER BY created_at DESC LIMIT 50
    )
  `).run();
}

function listHealthReports(limit = 50) {
  return db.prepare('SELECT * FROM health_reports ORDER BY created_at DESC LIMIT ?').all(limit);
}

module.exports = {
  db,
  upsertMany,
  listUtrudnienia,
  getDailyFact,
  deleteDailyFact,
  saveDailyFact,
  getRecentFacts,
  getLatestFact,
  recordSourceResult,
  markSourceAlerted,
  recordPushAttempt,
  checkPushSilence,
  getPushStats,
  ensurePushLogStarted,
  listSourceHealth,
  listSubscriptionSummary,
  saveSubscription,
  deleteSubscription,
  getAllSubscriptions,
  listActiveAds,
  createAd,
  updateAd,
  deactivateAd,
  listAllAds,
  deactivateExpiredAds,
  getAdsNeedingReminder,
  markReminderSent,
  saveHealthReport,
  listHealthReports,
};
