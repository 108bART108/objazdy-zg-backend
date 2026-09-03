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
    fetched_at TEXT NOT NULL DEFAULT (datetime('now')),
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_utrudnienia_category ON utrudnienia(category);
  CREATE INDEX IF NOT EXISTS idx_utrudnienia_published ON utrudnienia(published_at DESC);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    subscription_json TEXT NOT NULL,
    categories TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS daily_fact (
    fact_date TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS local_ads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    tagline TEXT NOT NULL,
    link_url TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

const migrations = [
  'ALTER TABLE local_ads ADD COLUMN expires_at TEXT',
  'ALTER TABLE local_ads ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0',
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
  INSERT INTO utrudnienia (source_url, source_name, category, title, street, description, published_at)
  VALUES (@source_url, @source_name, @category, @title, @street, @description, COALESCE(@published_at, datetime('now')))
  ON CONFLICT(source_url) DO UPDATE SET
    title = excluded.title,
    street = excluded.street,
    description = excluded.description,
    published_at = COALESCE(@published_at, utrudnienia.published_at),
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
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const alreadyExists = existsStmt.get(row.source_url);
      if (!alreadyExists) newItems.push(row);
      upsertStmt.run({ ...row, published_at: sanitizePublishedAt(row.published_at) });
    }
  });
  tx(items);
  return { count: items.length, newItems };
}

function listUtrudnienia({ category, search, limit = 50 } = {}) {
  let query = 'SELECT * FROM utrudnienia WHERE active = 1';
  const params = {};

  if (category && category !== 'all') {
    query += ' AND category = @category';
    params.category = category;
  }
  if (search) {
    query += ' AND (title LIKE @search OR street LIKE @search OR description LIKE @search)';
    params.search = `%${search}%`;
  }
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

function saveDailyFact(date, content) {
  db.prepare(`
    INSERT INTO daily_fact (fact_date, content) VALUES (@date, @content)
    ON CONFLICT(fact_date) DO UPDATE SET content = excluded.content
  `).run({ date, content });
}

function getRecentFacts(limit = 20) {
  return db.prepare('SELECT content FROM daily_fact ORDER BY fact_date DESC LIMIT ?')
    .all(limit)
    .map((r) => r.content);
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

module.exports = {
  db,
  upsertMany,
  listUtrudnienia,
  getDailyFact,
  deleteDailyFact,
  saveDailyFact,
  getRecentFacts,
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
};
