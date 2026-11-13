// Kontrola spojnosci plikow backendu, uruchamiana raz przy starcie serwera.
//
// POWOD POWSTANIA: 29.10.2026 na serwerze znalazl sie nowy scrapeAll.js
// obok starszego db.js. Nowy kod wolal funkcje, ktorej stara wersja bazy
// jeszcze nie eksportowala. Skutek: scrapowanie padalo CO 10 MINUT przez
// prawie godzine i ani jeden nowy wpis nie trafil do appki - a jedynym
// sladem byl blad w logach Render, ktory trzeba bylo samemu zauwazyc.
//
// Niespojne wdrozenie to normalna rzecz, gdy pliki wgrywa sie recznie:
// zawsze moze sie zdarzyc, ze jeden z kilku nie dojdzie. Dlatego zamiast
// liczyc na bezblednosc wgrywania, backend sam sprawdza przy starcie, czy
// wszystkie pliki do siebie pasuja - i mowi wprost, czego brakuje.

const REQUIRED_DB_EXPORTS = [
  'upsertMany',
  'listUtrudnienia',
  'recordSourceResult',
  'markSourceAlerted',
  'listSourceHealth',
  'getDescriptionsByUrls',
  'getSetting',
  'deactivateByUrls',
  'setSetting',
  'recordPushAttempt',
  'checkPushSilence',
  'getPushStats',
  'saveSubscription',
  'deleteSubscription',
  'getAllSubscriptions',
  'listSubscriptionSummary',
  'saveHealthReport',
  'listHealthReports',
];

const REQUIRED_PUSH_EXPORTS = ['notifySubscribers', 'sendTestNotification', 'checkPushConfig'];

// Tabele i kolumny, bez ktorych cos po cichu przestanie dzialac.
const REQUIRED_TABLES = {
  utrudnienia: ['id', 'source_url', 'category', 'title', 'published_at', 'event_date', 'fetched_at', 'needs_review'],
  push_subscriptions: ['endpoint', 'subscription_json', 'categories'],
  push_log: ['kind', 'kandydatow', 'dostarczono', 'bledow', 'pominieto_stare', 'pominieto_kategorie'],
  source_health: ['source', 'empty_streak', 'alerted'],
  app_state: ['klucz', 'wartosc'],
  health_reports: ['report', 'has_problem'],
};

function runStartupCheck() {
  const problemy = [];

  let dbModule;
  try {
    dbModule = require('./db');
  } catch (err) {
    problemy.push(`nie udalo sie wczytac db.js: ${err.message}`);
    zglos(problemy);
    return problemy;
  }

  // 1. Czy baza udostepnia wszystko, czego oczekuje reszta kodu.
  const brakujaceDb = REQUIRED_DB_EXPORTS.filter((f) => typeof dbModule[f] !== 'function');
  if (brakujaceDb.length) {
    problemy.push(
      `db.js nie udostepnia: ${brakujaceDb.join(', ')} - prawdopodobnie wgrany plik jest STARSZA wersja niz pozostale. `
      + 'Wgraj najnowszy db.js, inaczej scrapowanie bedzie padac co cykl.'
    );
  }

  // 2. Czy upsertMany zwraca ten kształt, ktorego uzywa scrapeAll.
  //    Wywolanie z pusta lista nic nie zapisuje, wiec jest bezpieczne.
  if (typeof dbModule.upsertMany === 'function') {
    try {
      const wynik = dbModule.upsertMany([]) || {};
      const brakujacePola = ['count', 'newItems', 'flaggedItems'].filter((k) => wynik[k] === undefined);
      if (brakujacePola.length) {
        problemy.push(
          `upsertMany() nie zwraca pol: ${brakujacePola.join(', ')} - scrapeAll.js i db.js sa z roznych wersji. Wgraj oba najnowsze.`
        );
      }
    } catch (err) {
      problemy.push(`upsertMany() rzuca wyjatkiem przy wywolaniu probnym: ${err.message}`);
    }
  }

  // 3. Czy modul powiadomien udostepnia to, czego uzywa server.js.
  try {
    const pushModule = require('./push');
    const brakujacePush = REQUIRED_PUSH_EXPORTS.filter((f) => typeof pushModule[f] !== 'function');
    if (brakujacePush.length) {
      problemy.push(`push.js nie udostepnia: ${brakujacePush.join(', ')} - wgraj najnowszy push.js`);
    }
  } catch (err) {
    problemy.push(`nie udalo sie wczytac push.js: ${err.message}`);
  }

  // 4. Czy baza ma wszystkie tabele i kolumny.
  if (dbModule.db) {
    for (const [tabela, kolumny] of Object.entries(REQUIRED_TABLES)) {
      try {
        const istniejace = dbModule.db.prepare(`PRAGMA table_info(${tabela})`).all().map((k) => k.name);
        if (!istniejace.length) {
          problemy.push(`brak tabeli "${tabela}" w bazie - wgrany db.js jej nie tworzy`);
          continue;
        }
        const brak = kolumny.filter((k) => !istniejace.includes(k));
        if (brak.length) {
          problemy.push(`tabela "${tabela}" nie ma kolumn: ${brak.join(', ')}`);
        }
      } catch (err) {
        problemy.push(`nie udalo sie sprawdzic tabeli "${tabela}": ${err.message}`);
      }
    }
  }

  zglos(problemy);

  // Kontrola tresci jest celowo PO zgloszeniu spojnosci i w osobnym
  // try/catch: nawet jej calkowita awaria nie moze przeszkodzic
  // w starcie serwera ani zgubic wyniku kontroli spojnosci.
  try {
    sprawdzTresc();
  } catch (err) {
    console.error('[start] kontrola tresci nie wykonala sie:', err.message);
  }

  return problemy;
}

// ===================== KONTROLA TRESCI =====================
//
// Kontrola spojnosci wyzej pilnuje, czy pliki do siebie PASUJA. Nie powie
// jednak nic o tym, czy nadal ROBIA to, co powinny. 13.11.2026 okazalo sie,
// ze filtr komunikatow nie zna slowa "budowa", komunikaty ZWiK o ruchu
// laduja w zakladce "woda", a opisy MZK ucinane sa przez prog 60 znakow -
// wszystkie pliki byly przy tym idealnie spojne.
//
// Dlatego przy kazdym starcie uruchamiamy jeszcze zestawy przypadkow z
// testUmZgora.js i testMzkOpis.js. To czyste funkcje tekstowe, bez sieci
// i bez bazy, wiec kosztuja ulamek sekundy.
//
// ZASADA: kontrola tresci NIGDY nie moze zatrzymac serwera. Bledny test
// oznacza, ze cos dziala gorzej - a nie, ze ma nie dzialac nic. Dlatego
// kazdy test jest w osobnym try/catch i nie ma tu zadnego process.exit().
const TESTY_TRESCI = [
  ['filtr i kategorie komunikatow', './testUmZgora'],
  ['wyciaganie opisow MZK', './testMzkOpis'],
];

function sprawdzTresc() {
  let sprawdzonych = 0;
  const problemy = [];

  for (const [nazwa, modul] of TESTY_TRESCI) {
    try {
      // eslint-disable-next-line global-require, import/no-dynamic-require
      const { uruchomTesty } = require(modul);
      if (typeof uruchomTesty !== 'function') {
        problemy.push(`${nazwa}: plik testu nie udostepnia funkcji uruchomTesty`);
        continue;
      }
      const wynik = uruchomTesty();
      sprawdzonych += wynik.sprawdzonych || 0;
      for (const blad of wynik.bledy || []) problemy.push(`${nazwa} - ${blad}`);
    } catch (err) {
      // Brak pliku testu to nie powod do paniki (np. ktos go nie wgral),
      // ale warto o tym wiedziec.
      problemy.push(`${nazwa}: nie udalo sie uruchomic testu (${err.message})`);
    }
  }

  if (!problemy.length) {
    console.log(`[start] kontrola tresci: OK (${sprawdzonych} przypadkow)`);
    return problemy;
  }

  console.error('');
  console.error('==========================================================');
  console.error(`[start] UWAGA: KONTROLA TRESCI ZGLASZA ${problemy.length} PROBLEM(OW)`);
  console.error('[start] Appka dziala, ale cos moze trafiac w zle miejsce');
  console.error('[start] albo byc wyswietlane niepoprawnie:');
  for (const p of problemy) console.error(`[start]   - ${p}`);
  console.error('==========================================================');
  console.error('');
  return problemy;
}

function zglos(problemy) {
  if (!problemy.length) {
    console.log('[start] kontrola spojnosci plikow: OK');
    return;
  }
  // Glosno i jednoznacznie - ten komunikat ma byc widoczny w logach
  // wdrozenia od razu, a nie odkrywany po godzinie padania crona.
  console.error('');
  console.error('==========================================================');
  console.error('[start] UWAGA: PLIKI BACKENDU NIE SA SPOJNE');
  console.error('[start] Appka moze nie zapisywac nowych wpisow!');
  for (const p of problemy) console.error(`[start]   - ${p}`);
  console.error('==========================================================');
  console.error('');
}

module.exports = { runStartupCheck };
