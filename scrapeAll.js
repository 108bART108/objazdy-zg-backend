const { fetchUmZgora } = require('./umZgora');
const { fetchHtmlSources } = require('./htmlSources');
const { fetchEnea } = require('./enea');
const { fetchMzk } = require('./mzk');
const { fetchZwik } = require('./zwik');
const { fetchZdw } = require('./zdw');
const { upsertMany } = require('./db');
const { notifySubscribers } = require('./push');
const { qualityCheck } = require('./qualityCheck');

// Normalizuje tekst do porownania "czy to ta sama tresc" - male litery,
// pojedyncze spacje, bez koncowej interpunkcji. Dzieki temu dwa wpisy
// rozne tylko o niewidoczna spacje/znak bialy (np. zrodlo publikuje ten
// sam komunikat w dwoch blokach HTML z drobna roznica w otaczajacym
// tekscie) i tak zostana rozpoznane jako duplikat, mimo ze ich
// source_url/hash sie roznia.
function normalizeForDedup(text) {
  return (text || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[.,;:…]+$/, '')
    .trim();
}

// Deduplikacja PO TRESCI (kategoria + tytul + opis), niezaleznie od
// source_url - to dodatkowa siatka bezpieczenstwa ponad deduplikacja po
// source_url, ktora juz dzieje sie w bazie (ON CONFLICT). Gdy dwa wpisy
// z tego samego przebiegu scrapowania maja identyczna tresc po
// normalizacji, zostaje tylko pierwszy.
function dedupeByContent(items) {
  const seen = new Set();
  const result = [];
  for (const item of items) {
    const key = `${item.category}||${normalizeForDedup(item.title)}||${normalizeForDedup(item.description)}`;
    if (seen.has(key)) {
      console.warn(`[scrapeAll] pominieto duplikat tresci [${item.category}] "${item.title}" (${item.source_url})`);
      continue;
    }
    seen.add(key);
    result.push(item);
  }
  return result;
}

// Wpis "nowy dla naszego systemu" (pierwszy raz zobaczony przez scraper)
// to NIE to samo co "swiezo opublikowany" - zrodlo moze umiescic na
// liscie "najnowsze" artykul sprzed miesiecy (np. gdy inne, nowsze
// wpisy zniknely z listy, robiac miejsce starszym). W takim przypadku
// wysylanie push "nowe utrudnienie!" wprowadzaloby w blad: uzytkownik
// dostaje powiadomienie, ale sam wpis - sortowany scisle po dacie
// publikacji - ladowalby na samym dole listy, wiec trudno go znalezc.
// Push wysylamy wiec TYLKO dla wpisow, ktorych prawdziwa data
// publikacji jest realnie niedawna (ostatnie 3 dni). Brak published_at
// (np. scraper nie zdolal go wyciagnac) traktujemy jako "swiezy" -
// bezpieczniejsze zalozenie niz milczec o czyms co moze byc wazne.
const PUSH_FRESHNESS_DAYS = 3;
function isRecentEnoughForPush(item) {
  if (!item.published_at) return true;
  const publishedAt = new Date(item.published_at);
  if (isNaN(publishedAt.getTime())) return true;
  const ageMs = Date.now() - publishedAt.getTime();
  return ageMs <= PUSH_FRESHNESS_DAYS * 86400000;
}

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
  const rawItems = [...fromRss, ...fromHtml, ...fromEnea, ...fromMzk, ...fromZwik, ...fromZdw]
    .filter((i) => i.title && i.source_url)
    .map(qualityCheck);

  const items = dedupeByContent(rawItems);

  const { count, newItems, flaggedItems } = upsertMany(items);

  const ms = Date.now() - started;
  const skipped = rawItems.length - items.length;
  console.log(`[scrapeAll] zapisano/zaktualizowano ${count} wpisow w ${ms}ms (nowych: ${newItems.length}, do przejrzenia: ${flaggedItems.length}, pominietych duplikatow: ${skipped})`);

  if (flaggedItems.length) {
    for (const item of flaggedItems) {
      console.warn(`[scrapeAll] do przejrzenia [${item.category}] "${item.title}" - ${item.review_reasons.join('; ')}`);
    }
  }

  // Wpisy oznaczone do przejrzenia NIE trafiaja na push - subskrybenci
  // nie dostana powiadomienia o bledzie ekstrakcji. Wpis i tak zostaje
  // zapisany w bazie, ale pozostaje automatycznie ukryty w appce (patrz
  // listUtrudnienia w db.js) dopoki kolejne scrapowanie nie da lepszego
  // wyniku - bez zadnego recznego kroku.
  //
  // Dodatkowo odsiewamy wpisy "nowe dla systemu", ale z data publikacji
  // starsza niz kilka dni (patrz komentarz przy isRecentEnoughForPush) -
  // zeby nie wysylac mylacych powiadomien o czyms, co i tak wyladuje na
  // dole listy posortowanej po dacie.
  const staleSkipped = [];
  const newItemsToNotify = newItems.filter((i) => {
    if (i.needs_review) return false;
    if (!isRecentEnoughForPush(i)) {
      staleSkipped.push(i);
      return false;
    }
    return true;
  });
  if (staleSkipped.length) {
    for (const item of staleSkipped) {
      console.log(`[scrapeAll] pominieto push dla "nowego" ale nieswiezego wpisu [${item.category}] "${item.title}" (published_at: ${item.published_at})`);
    }
  }
  if (newItemsToNotify.length) {
    notifySubscribers(newItemsToNotify).catch((err) => console.error('[push] blad wysylki powiadomien:', err.message));
  }

  return count;
}

module.exports = { scrapeAll };
