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
