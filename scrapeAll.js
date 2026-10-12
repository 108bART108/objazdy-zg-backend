const { fetchUmZgora } = require('./umZgora');
const { fetchHtmlSources } = require('./htmlSources');
const { fetchEnea } = require('./enea');
const { fetchMzk } = require('./mzk');
const { fetchZwik } = require('./zwik');
const { fetchZdw } = require('./zdw');
const { upsertMany } = require('./db');
const { notifySubscribers } = require('./push');
const { sanitizeItems } = require('./sanitize');

async function scrapeAll() {
  const started = Date.now();
  const [fromRss, fromHtml, fromEnea, fromMzk, fromZwik, fromZdw] = await Promise.all([
    fetchUmZgora(),
    fetchHtmlSources(),
    fetchEnea(),
    fetchMzk(),
    fetchZwik(),
    fetchZdw(),
  ]);

  const raw = [...fromRss, ...fromHtml, ...fromEnea, ...fromMzk, ...fromZwik, ...fromZdw]
    .filter((i) => i.title && i.source_url);

  // Jedno wspolne czyszczenie dla wszystkich zrodel naraz. Kazdy scraper moze
  // miec wlasne dziwactwa, ale smieci typu "1 godzine temu" czy "Uncategorized"
  // wygladaja tak samo wszedzie - lepiej lapac je w jednym miejscu, niz liczyc
  // na to, ze szesc osobnych funkcji zostanie zaktualizowanych jednoczesnie.
  const { items, warnings } = sanitizeItems(raw);

  if (warnings.length) {
    console.warn(`[scrapeAll] UWAGA: ${warnings.length} wpisow wyglada podejrzanie po czyszczeniu:`);
    for (const w of warnings) {
      console.warn(`  - [${w.category}] ${w.source_name}: ${w.problems.join('; ')}`);
      console.warn(`    tytul: "${w.title}"`);
      if (w.source_url) console.warn(`    zrodlo: ${w.source_url}`);
    }
    console.warn('[scrapeAll] prawdopodobnie zmienil sie uklad strony zrodlowej - sprawdz scraper tego zrodla.');
  }

  const skipped = raw.length - items.length;
  const { count, newItems } = upsertMany(items);

  const ms = Date.now() - started;
  console.log(
    `[scrapeAll] zapisano/zaktualizowano ${count} wpisow w ${ms}ms `
    + `(nowych: ${newItems.length}, pominietych jako niekompletne: ${skipped})`,
  );

  if (newItems.length) {
    notifySubscribers(newItems).catch((err) => console.error('[push] blad wysylki powiadomien:', err.message));
  }

  return count;
}

module.exports = { scrapeAll };
