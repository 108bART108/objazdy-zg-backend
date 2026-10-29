const { fetchUmZgora } = require('./umZgora');
const { fetchHtmlSources } = require('./htmlSources');
const { fetchEnea } = require('./enea');
const { fetchMzk } = require('./mzk');
const { fetchZwik } = require('./zwik');
const { fetchZdw } = require('./zdw');
const { upsertMany, recordSourceResult, markSourceAlerted, recordPushAttempt } = require('./db');
const { sendSystemAlert } = require('./systemAlerts');
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

// Maksymalna liczba powiadomien na jeden cykl scrapowania. Zabezpieczenie
// przed zalewem: gdy zepsute zrodlo (np. MZK zablokowane po IP) zaczyna
// znow dzialac, scraper widzi naraz kilkanascie "nowych" wpisow. Bez tego
// limitu uzytkownik dostalby kilkanascie powiadomien w jednej minucie i
// najpewniej wylaczylby je na stale. Nadwyzka jest widoczna w appce od
// razu - tylko bez osobnego dzwieku dla kazdego wpisu.
const PUSH_MAX_PER_CYCLE = 5;

function parseDate(value) {
  if (!value) return null;
  const d = new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

// Czy wpis zasluguje na powiadomienie.
//
// Sama data publikacji to zly jedyny wyznacznik, co pokazala awaria MZK:
// po jej naprawie do appki trafily komunikaty opublikowane kilka-kilkanascie
// dni wczesniej, ale dotyczace zmian w trasach jeszcze PRZED nami. W appce
// byly widoczne, a push sie nie wysylal - czytelnicy nie dowiedzieli sie o
// zmianach, ktore ich dopiero czekaly. To bylo odwrotnie niz powinno.
//
// Dlatego powiadamiamy, gdy wpis jest swiezo opublikowany ALBO gdy dotyczy
// wydarzenia, ktore trwa lub jeszcze sie nie zaczelo - bo wlasnie wtedy
// informacja ma dla czytelnika realna wartosc. Odsiewamy natomiast wpisy
// stare I dotyczace zamknietej juz przeszlosci.
//
// Brak jakiejkolwiek daty traktujemy jako "warte powiadomienia" -
// bezpieczniej powiedziec o czyms moze waznym niz przemilczec.
function isRecentEnoughForPush(item) {
  const publishedAt = parseDate(item.published_at);
  if (!publishedAt) return true;

  const ageMs = Date.now() - publishedAt.getTime();
  if (ageMs <= PUSH_FRESHNESS_DAYS * 86400000) return true;

  // Starszy wpis, ale wydarzenie dopiero bedzie albo wlasnie trwa.
  // Porownujemy do POCZATKU dzisiejszego dnia, zeby utrudnienie
  // obowiazujace wlasnie dzisiaj nadal sie liczylo.
  const eventDate = parseDate(item.event_date);
  if (eventDate) {
    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);
    if (eventDate.getTime() >= startOfToday.getTime()) return true;
  }

  return false;
}

// Ile cykli z rzedu zrodlo moze nie zwrocic ANI JEDNEGO wpisu, zanim
// uznamy to za awarie. Scrapowanie chodzi co 10 minut, wiec 8 cykli to
// okolo 80 minut - na tyle dlugo, by nie alarmowac przy chwilowej awarii
// strony, i na tyle krotko, by nie dowiedziec sie o problemie po tygodniu.
const EMPTY_CYCLES_BEFORE_ALERT = 8;

// Zrodla, ktore moga byc puste z zalozenia (htmlSources ma celowo pusta
// liste zrodel) - ich nie pilnujemy.
const SOURCES_ALLOWED_EMPTY = ['htmlSources'];

// Sprawdza, czy ktores zrodlo przestalo zwracac wpisy, i wysyla JEDEN
// alert push na incydent (oraz jeden, gdy problem sam ustapi).
async function checkSourcesHealth(perSource) {
  for (const [source, items] of Object.entries(perSource)) {
    if (SOURCES_ALLOWED_EMPTY.includes(source)) continue;

    const state = recordSourceResult(source, items.length);

    if (items.length > 0) {
      if (state.wasBroken) {
        console.log(`[scrapeAll] zrodlo ${source} znowu dziala (${items.length} wpisow)`);
        await sendSystemAlert(
          `Naprawione: ${source}`,
          `Zrodlo ${source} znowu zwraca wpisy (${items.length}).`
        ).catch(() => {});
      }
      continue;
    }

    console.warn(`[scrapeAll] zrodlo ${source}: 0 wpisow (${state.emptyStreak} cykl(i) z rzedu)`);

    if (state.emptyStreak >= EMPTY_CYCLES_BEFORE_ALERT && !state.alreadyAlerted) {
      const since = state.lastOkAt ? new Date(state.lastOkAt).toLocaleString('pl-PL', { timeZone: 'Europe/Warsaw' }) : 'nieznany';
      console.error(`[scrapeAll] ALERT: zrodlo ${source} nie zwraca wpisow od ${state.emptyStreak} cykli (ostatnio dzialalo: ${since})`);
      await sendSystemAlert(
        `Awaria zrodla: ${source}`,
        `Brak wpisow od ${state.emptyStreak} cykli scrapowania. Ostatnio dzialalo: ${since}. Sprawdz logi Render.`
      ).catch(() => {});
      markSourceAlerted(source);
    }
  }
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
  // Kontrola zdrowia zrodel PRZED zapisem - zrodlo, ktore nagle przestaje
  // cokolwiek zwracac, zwykle nie oznacza "brak utrudnien w miescie", tylko
  // zepsuty scraper (np. strona zaczela blokowac nasze zapytania).
  await checkSourcesHealth({
    umZgora: fromRss,
    htmlSources: fromHtml,
    enea: fromEnea,
    mzk: fromMzk,
    zwik: fromZwik,
    zdw: fromZdw,
  }).catch((err) => console.error('[scrapeAll] blad kontroli zdrowia zrodel:', err.message));

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
  let newItemsToNotify = newItems.filter((i) => {
    if (i.needs_review) return false;
    if (!isRecentEnoughForPush(i)) {
      staleSkipped.push(i);
      return false;
    }
    return true;
  });
  if (staleSkipped.length) {
    for (const item of staleSkipped) {
      console.log(`[scrapeAll] pominieto push: wpis stary i wydarzenie juz minelo [${item.category}] "${item.title}" (publikacja: ${item.published_at}, wydarzenie: ${item.event_date || 'brak'})`);
    }
  }

  // Przy nadwyzce powiadamiamy o najnowszych - one najpewniej dotycza
  // tego, co uzytkownika czeka. Reszta i tak jest widoczna w appce.
  if (newItemsToNotify.length > PUSH_MAX_PER_CYCLE) {
    const nadwyzka = newItemsToNotify.length - PUSH_MAX_PER_CYCLE;
    newItemsToNotify = [...newItemsToNotify]
      .sort((a, b) => new Date(b.published_at || 0) - new Date(a.published_at || 0))
      .slice(0, PUSH_MAX_PER_CYCLE);
    console.log(`[scrapeAll] limit powiadomien: wysylam ${PUSH_MAX_PER_CYCLE} najnowszych, ${nadwyzka} wpisow bez push (sa widoczne w appce)`);
  }

  // Kazdy cykl, w ktorym pojawily sie nowe wpisy, zostawia slad w
  // dzienniku - TAKZE gdy nie wyszlo ani jedno powiadomienie. Wlasnie ten
  // przypadek byl wczesniej niewidoczny: wpisy wchodzily do appki, push
  // byl po cichu odfiltrowywany, i nie bylo zadnego zapisu, z ktorego
  // dalo by sie to zauwazyc. Teraz checkPushSilence() ma na czym pracowac.
  if (newItems.length) {
    const zapiszDziennik = (wynik) => {
      try {
        recordPushAttempt({
          kandydatow: newItemsToNotify.length,
          dostarczono: wynik.dostarczono || 0,
          bledow: wynik.bledow || 0,
          pominietoStare: staleSkipped.length,
          pominietoKategorie: wynik.pominietoKategorie || 0,
          szczegoly: wynik.powod || null,
        });
      } catch (err) {
        // Dziennik jest narzedziem diagnostycznym - jego awaria nie moze
        // przerwac scrapowania ani wysylki powiadomien.
        console.error('[push] nie udalo sie zapisac dziennika:', err.message);
      }
    };

    if (newItemsToNotify.length) {
      notifySubscribers(newItemsToNotify)
        .then((wynik) => zapiszDziennik(wynik || {}))
        .catch((err) => {
          console.error('[push] blad wysylki powiadomien:', err.message);
          zapiszDziennik({ powod: `blad wysylki: ${err.message}` });
        });
    } else {
      zapiszDziennik({ powod: 'wszystkie nowe wpisy odfiltrowane przed wysylka' });
    }
  }

  return count;
}

module.exports = { scrapeAll };
