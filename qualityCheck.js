// qualityCheck.js
//
// Wspolna warstwa "podwojnego sprawdzenia" jakosci wpisow, uruchamiana
// dla KAZDEGO wpisu z KAZDEJ kategorii (drogi, mzk, wodociagi, prad),
// tuz przed zapisem do bazy - niezaleznie od logiki konkretnego scrapera.
//
// Nie wymaga zadnego API ani kosztow - to czysto regulowa heurystyka.
//
// Cel: zlapac wpisy typu z przykladu MZK:
//   title:       "ul. Chemiczna 865-713 Zielona Gora"          (sam adres/kod, zero kontekstu)
//   description: "...odpowiedzialnosciaul. Chemiczna..."       (sklejona stopka firmowa, bez spacji)
//
// Wpisy, ktore nie przejda testow, NIE sa odrzucane (mogloby to zgubic
// prawdziwa informacje) - dostaja flage needs_review=true. Frontend/push
// powinien traktowac je inaczej (patrz uwagi na koncu pliku).

// --- Wzorce typowe dla "stopki firmowej" zamiast tresci komunikatu ---
const BOILERPLATE_PATTERNS = [
  /sp[oó]łka z ograniczon[aą] odpowiedzialno/i,
  /\bnip:?\s*\d/i,
  /\bregon:?\s*\d/i,
  /^ul\.\s?[\wżźćąśęłóńĄŚĘŁÓŃŻŹĆ.\- ]{2,30}\s+\d+[\/\-]?\d*\s+\d{2}-\d{3}/i, // sam adres z kodem pocztowym
  // banery/komunikaty o cookies i RODO - czesto pierwszy dluzszy <p> na stronie
  /pliki?\s+cookies?|ustawie(ń|niami)?\s+(dotycz\S*\s+)?cookies|ustawieniami\s+przegl\p{L}darki|korzystaj\p{L}c\s+z\s+(naszego\s+)?serwisu\s+bez\s+zmiany/iu,
];

// --- Slowa, ktorych obecnosc w tytule oznacza ze faktycznie opisuje on
//     zdarzenie (a nie jest samym adresem/kodem trasy) ---
const EVENT_WORDS = [
  'zmiana', 'zmiany', 'zmieni', 'objazd', 'remont', 'awari', 'wyłączeni',
  'wylaczeni', 'przerwa', 'zawieszon', 'utrudnie', 'kursuj', 'trasa', 'trasy',
  'trasie', 'linii', 'linia', 'roboty', 'prace', 'naprawa', 'planowan',
  'komunikat', 'informacj', 'wstrzyman', 'zamknieci', 'zamkniet',
];

// Wstawia spacje tam, gdzie mala i wielka litera sa sklejone bez separatora
// - typowy efekt $(el).text() na sasiadujacych elementach / <br> bez spacji
// np. "odpowiedzialnosciaul." -> "odpowiedzialnosciaul." (male+male, nie zlapie)
// ale "odpowiedzialnością" + "ul." -> gdy nastepne slowo zaczyna sie duza
// litera po malej - to zlapiemy. Dodatkowo lapiemy zlepek litera+"ul."/"al."
function fixGluedText(text) {
  if (!text) return text;
  let fixed = text.replace(/([a-ząćęłńóśźż])([A-ZĄĆĘŁŃÓŚŹŻ])/g, '$1 $2');
  // czesty przypadek: "...odpowiedzialnosciaul. Chemiczna" - male "a" + "ul."
  fixed = fixed.replace(/([a-ząćęłńóśźż])(ul\.|al\.|pl\.)\s?([A-ZĄĆĘŁŃÓŚŹŻ])/g, '$1 $2 $3');
  return fixed.replace(/\s+/g, ' ').trim();
}

function looksLikeBoilerplate(text) {
  if (!text) return false;
  return BOILERPLATE_PATTERNS.some((re) => re.test(text));
}

// Tytul, ktory nie mowi nic o TYM CO SIE STALO - sam adres/kod bez
// zadnego slowa-zdarzenia z listy EVENT_WORDS.
function titleLacksContext(title) {
  if (!title) return true;
  const lower = title.toLowerCase();
  const hasEventWord = EVENT_WORDS.some((w) => lower.includes(w));
  if (hasEventWord) return false;

  const startsWithStreet = /^(ul\.|al\.|pl\.)\s/i.test(title.trim());
  // np. "865-713" - wyglada na kod trasy/przystanku, nie na informacje
  const hasBareCodeNumber = /\b\d{2,4}-\d{2,4}\b/.test(title);

  return startsWithStreet || hasBareCodeNumber;
}

/**
 * Glowna funkcja - przyjmuje surowy wpis ze scrapera, zwraca poprawiony
 * wpis (z naprawionymi sklejeniami) + ewentualna flage needs_review.
 *
 * @param {object} entry - wpis z pol: title, description, category, source_name
 * @returns {object} entry rozszerzony o needs_review (bool) i review_reasons (string[])
 */
function qualityCheck(entry) {
  let title = fixGluedText(entry.title);
  let description = fixGluedText(entry.description);

  const reasons = [];

  if (looksLikeBoilerplate((description || '').slice(0, 150))) {
    reasons.push('opis wyglada na stopke firmowa / dane adresowe, nie na tresc komunikatu');
  }
  if (titleLacksContext(title)) {
    reasons.push('tytul to sam adres/kod bez informacji o tym co sie stalo');
  }
  // Opis identyczny z tytulem NIE jest sam w sobie problemem - to typowy,
  // nieszkodliwy fallback gdy scraper nie znalazl na stronie artykulu
  // dluzszego opisu (patrz mzk.js: description = descriptions[i] || a.title).
  // Jesli tytul sam w sobie ma kontekst (przeszedl titleLacksContext), to
  // czytelnik i tak dostaje prawdziwa informacje - nie ma potrzeby ukrywac
  // wpisu tylko dlatego ze brakuje dodatkowego opisu.
  //
  // Prawdziwie "urwany"/zepsuty opis lapiemy tylko gdy jest bardzo krotki
  // (ponizej 15 znakow) ORAZ rozny od tytulu - bo to sygnalizuje ucieta
  // ekstrakcje (np. sam fragment zdania), a nie po prostu brak opisu.
  if (
    description &&
    title &&
    description.trim().toLowerCase() !== title.trim().toLowerCase() &&
    description.trim().length < 15
  ) {
    reasons.push('opis bardzo krotki i inny niz tytul - moze byc urwany fragment');
  }
  // Opis konczacy sie dwukropkiem to prawie zawsze zapowiedz listy, ktora
  // nie zostala wyciagnieta (np. "przywrocone zostana stale trasy linii:"
  // i tu sie urywa, bo prawdziwa lista linii siedzi w osobnym <ul> na
  // stronie zrodlowej, ktorego scraper nie zlapal).
  if (description && /:\s*$/.test(description.trim())) {
    reasons.push('opis urywa sie na dwukropku - prawdopodobnie brakuje dalszej czesci (np. listy)');
  }

  return {
    ...entry,
    title,
    description,
    needs_review: reasons.length > 0,
    review_reasons: reasons.length > 0 ? reasons : undefined,
  };
}

module.exports = { qualityCheck, fixGluedText, looksLikeBoilerplate, titleLacksContext };

// --- Uwagi do integracji (nie kod, do przeczytania) ---
//
// 1. W scrapeAll.js: kazdy wpis z kazdego scrapera (drogi/mzk/wodociagi/prad)
//    powinien przejsc przez qualityCheck(entry) PRZED zapisem do bazy (db.js).
//
// 2. W db.js: dodaj kolumne `needs_review INTEGER DEFAULT 0` (+ opcjonalnie
//    `review_reasons TEXT`) do tabeli wpisow, i zapisuj te wartosci z entry.
//
// 3. W push.js: NIE wysylaj powiadomienia push dla wpisu z needs_review=1
//    (zeby "belkot" nie trafil od razu do subskrybentow) - ale sam wpis
//    nadal moze byc widoczny w appce, ewentualnie z dyskretna plakietka.
//
// 4. W admin.html: dodaj widok/liste "Do sprawdzenia" pokazujacy wpisy
//    z needs_review=1 wraz z review_reasons, z mozliwoscia recznej edycji
//    tytulu/opisu i "zatwierdzenia" (needs_review=0) - to Twoj rzeczywisty
//    drugi zestaw oczu, tani i szybki, bo AI/regula juz odsiala oczywiste
//    smieci, a Ty poprawiasz tylko te niepewne przypadki.
