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

// Migracja: dodaj kolumne image_url, jesli tabela zostala juz utworzona
// wczesniej (przed dodaniem tej funkcji) i jeszcze jej nie ma. ALTER TABLE
// rzuca blad, jesli kolumna juz istnieje - ignorujemy to bezpiecznie.
try {
  db.exec('ALTER TABLE local_ads ADD COLUMN image_url TEXT');
} catch (err) {
  // kolumna juz istnieje - nic nie robimy
}

const upsertStmt = db.prepare(`
  INSERT INTO utrudnienia (source_url, source_name, category, title, street, description, published_at)
  VALUES (@source_url, @source_name, @category, @title, @street, @description, @published_at)
  ON CONFLICT(source_url) DO UPDATE SET
    title = excluded.title,
    street = excluded.street,
    description = excluded.description,
    published_at = excluded.published_at,
    active = 1
`);

const existsStmt = db.prepare('SELECT 1 FROM utrudnienia WHERE source_url = ?');

function upsertMany(items) {
  const newItems = [];
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const alreadyExists = existsStmt.get(row.source_url);
      if (!alreadyExists) newItems.push(row);
      upsertStmt.run(row);
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

// --- Subskrypcje powiadomien push ---

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

// --- Reklamy lokalnych firm ---

function listActiveAds() {
  return db.prepare('SELECT * FROM local_ads WHERE active = 1 ORDER BY id DESC').all();
}

function createAd({ business_name, tagline, link_url, image_url }) {
  const info = db.prepare(`
    INSERT INTO local_ads (business_name, tagline, link_url, image_url)
    VALUES (@business_name, @tagline, @link_url, @image_url)
  `).run({ business_name, tagline, link_url, image_url: image_url || null });
  return info.lastInsertRowid;
}

function updateAd(id, { business_name, tagline, link_url, image_url }) {
  db.prepare(`
    UPDATE local_ads
    SET business_name = @business_name,
        tagline = @tagline,
        link_url = @link_url,
        image_url = @image_url
    WHERE id = @id
  `).run({ id, business_name, tagline, link_url, image_url: image_url || null });
}

function deactivateAd(id) {
  db.prepare('UPDATE local_ads SET active = 0 WHERE id = ?').run(id);
}

function listAllAds() {
  return db.prepare('SELECT * FROM local_ads ORDER BY id DESC').all();
}

module.exports = {
  db,
  upsertMany,
  listUtrudnienia,
  getDailyFact,
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
};
