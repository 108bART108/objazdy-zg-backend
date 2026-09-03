const { fetchUmZgora } = require('./umZgora');
const { fetchHtmlSources } = require('./htmlSources');
const { fetchEnea } = require('./enea');
const { fetchMzk } = require('./mzk');
const { fetchZwik } = require('./zwik');
const { fetchZdw } = require('./zdw');
const { upsertMany } = require('./db');
const { notifySubscribers } = require('./push');
const { qualityCheck } = require('./qualityCheck');

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

  // Centralne, drugie sprawdzenie jakosci - dotyczy WSZYSTKICH zrodel
  // (rowniez umZgora.js i htmlSources.js, ktore nie robia tego same),
  // wiec kazdy wpis z kazdej kategorii przechodzi przez qualityCheck
  // niezaleznie od tego, czy dany scraper juz to zrobil wczesniej
  // (funkcja jest bezpieczna do powtornego wywolania - nie psuje juz
  // poprawionego tekstu).
  const items = [...fromRss, ...fromHtml, ...fromEnea, ...fromMzk, ...fromZwik, ...fromZdw]
    .filter((i) => i.title && i.source_url)
    .map(qualityCheck);

  const { count, newItems, flaggedItems } = upsertMany(items);

  const ms = Date.now() - started;
  console.log(`[scrapeAll] zapisano/zaktualizowano ${count} wpisow w ${ms}ms (nowych: ${newItems.length}, do przejrzenia: ${flaggedItems.length})`);

  if (flaggedItems.length) {
    for (const item of flaggedItems) {
      console.warn(`[scrapeAll] do przejrzenia [${item.category}] "${item.title}" - ${item.review_reasons.join('; ')}`);
    }
  }

  // Wpisy oznaczone do przejrzenia NIE trafiaja na push - subskrybenci
  // nie dostana powiadomienia o bebechu/bledzie ekstrakcji. Wpis i tak
  // zostaje zapisany w bazie, ale pozostaje ukryty w appce (patrz
  // listUtrudnienia w db.js) dopoki ktos go recznie nie zatwierdzi
  // w panelu admina.
  const newItemsToNotify = newItems.filter((i) => !i.needs_review);
  if (newItemsToNotify.length) {
    notifySubscribers(newItemsToNotify).catch((err) => console.error('[push] blad wysylki powiadomien:', err.message));
  }

  return count;
}

module.exports = { scrapeAll };
