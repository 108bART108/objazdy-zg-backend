const { fetchUmZgora } = require('./umZgora');
const { fetchHtmlSources } = require('./htmlSources');
const { upsertMany } = require('./db');

async function scrapeAll() {
  const started = Date.now();
  const [fromRss, fromHtml] = await Promise.all([
    fetchUmZgora(),
    fetchHtmlSources(),
  ]);

  const items = [...fromRss, ...fromHtml].filter((i) => i.title && i.source_url);
  const count = upsertMany(items);

  const ms = Date.now() - started;
  console.log(`[scrapeAll] zapisano/zaktualizowano ${count} wpisow w ${ms}ms`);
  return count;
}

module.exports = { scrapeAll };
