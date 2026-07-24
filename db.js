const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'objazdy.db');

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
    is_premium INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

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

function upsertMany(items) {
  const tx = db.transaction((rows) => {
    for (const row of rows) upsertStmt.run(row);
  });
  tx(items);
  return items.length;
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

module.exports = { db, upsertMany, listUtrudnienia };
