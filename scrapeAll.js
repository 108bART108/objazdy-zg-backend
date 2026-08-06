const { fetchUmZgora } = require('./umZgora');
const { fetchHtmlSources } = require('./htmlSources');
const { fetchEnea } = require('./enea');
const { fetchMzk } = require('./mzk');
const { fetchZwik } = require('./zwik');
const { upsertMany } = require('./db');
const { notifySubscribers } = require('./push');

async function scrapeAll() {
  const started = Date.now();
  const [fromRss, fromHtml, fromEnea, fromMzk, fromZwik] = await Promise.all([
    fetchUmZgora(),
    fetchHtmlSources(),
    fetchEnea(),
    fetchMzk(),
    fetchZwik(),
  ]);

  const items = [...fromRss, ...fromHtml, ...fromEnea, ...fromMzk, ...fromZwik].filter((i) => i.title && i.source_url);
  const { count, newItems } = upsertMany(items);

  const ms = Date.now() - started;
  console.log(`[scrapeAll] zapisano/zaktualizowano ${count} wpisow w ${ms}ms (nowych: ${newItems.length})`);

  if (newItems.length) {
    notifySubscribers(newItems).catch((err) => console.error('[push] blad wysylki powiadomien:', err.message));
  }

  return count;
}

module.exports = { scrapeAll };
