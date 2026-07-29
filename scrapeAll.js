const { fetchUmZgora } = require('./umZgora');
const { fetchHtmlSources } = require('./htmlSources');
const { fetchEnea } = require('./enea');
const { fetchMzk } = require('./mzk');
const { upsertMany } = require('./db');

async function scrapeAll() {
  const started = Date.now();
  const [fromRss, fromHtml, fromEnea, fromMzk] = await Promise.all([
    fetchUmZgora(),
    fetchHtmlSources(),
    fetchEnea(),
    fetchMzk(),
  ]);

  const items = [...fromRss, ...fromHtml, ...fromEnea, ...fromMzk].filter((i) => i.title && i.source_url);
  const count = upsertMany(items);

  const ms = Date.now() - started;
  console.log(`[scrapeAll] zapisano/zaktualizowano ${count} wpisow w ${ms}ms`);
  return count;
}

module.exports = { scrapeAll };
