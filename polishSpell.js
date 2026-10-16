// Deterministyczna kontrola ortografii i form fleksyjnych jezyka polskiego.
//
// Powod istnienia: model AI generujacy ciekawostke potrafi stworzyc slowo,
// ktore nie istnieje ("Niemczyko-polskie") albo uzyc zlej formy odmiany
// ("miasto srokow" zamiast "miasto srok"). Zaden prompt tego nie wyeliminuje
// w 100%, a takie bledy widza wszyscy uzytkownicy aplikacji. Dlatego ostatnia
// bramka przed publikacja jest prawdziwy slownik jezyka polskiego, a nie
// kolejne pytanie do modelu.
//
// Uzywamy hunspella skompilowanego do WebAssembly - wersja czysto
// javascriptowa (nspell) zjadala 469 MB RAM i ladowala sie 15 sekund, czyli
// nie zmiescilaby sie na instancji Render Starter. WASM potrzebuje ~46 MB
// i startuje w pol sekundy.

const fs = require('fs');
const path = require('path');

// Slowa poprawne, ktorych nie ma w slowniku ogolnym: lokalne nazwy wlasne,
// skroty instytucji i zielonogorskie slownictwo. Dopasowanie po przedrostku,
// zeby objac odmiane ("bachusik" -> "bachusikow", "bachusikami").
const LOCAL_WORDS = [
  'bachusik', 'bachus', 'winobrani', 'zielonogórsk', 'zielonogorsk',
  'lubusk', 'palmiarni', 'wagmostaw', 'łaziebn', 'laziebn',
  'racul', 'ochl', 'zawad', 'drzonk', 'przylep', 'jędrzych', 'jedrzych',
  'chynów', 'chynow', 'krępa', 'krepa', 'łężyc', 'lezyc', 'zatoni',
  'kisielin', 'barcikowic', 'ługow', 'lugow', 'piastowsk',
  'zwik', 'mzk', 'zdw', 'enea', 'enei', 'eneą',
];

// Poprawne czlony zlozen przymiotnikowych. Slownik odrzuca je pojedynczo
// (istnieja tylko w zlozeniu), wiec musza byc wymienione osobno. Lista jest
// zamknieta i kuratorowana - dzieki temu "Niemczyko-polskie" nadal wpada,
// bo "niemczyko" sie na niej nie znajduje.
const COMPOUND_PARTS = [
  'polsko', 'niemiecko', 'czesko', 'słowacko', 'slowacko', 'francusko',
  'angielsko', 'rosyjsko', 'ukraińsko', 'ukrainsko', 'litewsko', 'włosko',
  'wlosko', 'hiszpańsko', 'hiszpansko', 'austriacko', 'węgiersko',
  'wegiersko', 'żydowsko', 'zydowsko', 'śląsko', 'slasko', 'łużycko',
  'luzycko', 'europejsko', 'radziecko', 'biało', 'bialo', 'czarno',
  'jasno', 'ciemno', 'ogólno', 'ogolno', 'wielko', 'mało', 'malo',
];

// Znajduje pliki slownika. Pakiet dictionary-pl blokuje dostep do podsciezek
// przez pole "exports", wiec require.resolve nie zadziala - szukamy recznie,
// idac w gore drzewa katalogow.
function findDictionaryFiles() {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    const candidate = path.join(dir, 'node_modules', 'dictionary-pl');
    const aff = path.join(candidate, 'index.aff');
    const dic = path.join(candidate, 'index.dic');
    if (fs.existsSync(aff) && fs.existsSync(dic)) return { aff, dic };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

let initPromise = null;
let checker = null;
let unavailableReason = null;

async function init() {
  if (checker || unavailableReason) return;

  const files = findDictionaryFiles();
  if (!files) {
    unavailableReason = 'nie znaleziono pakietu dictionary-pl';
    console.warn(`[polishSpell] ${unavailableReason} - kontrola ortografii wylaczona`);
    return;
  }

  try {
    const { loadModule } = require('hunspell-asm');
    const factory = await loadModule();
    const affPath = factory.mountBuffer(fs.readFileSync(files.aff), 'pl.aff');
    const dicPath = factory.mountBuffer(fs.readFileSync(files.dic), 'pl.dic');
    checker = factory.create(affPath, dicPath);
    console.log('[polishSpell] slownik jezyka polskiego zaladowany');
  } catch (err) {
    unavailableReason = err.message;
    console.warn(`[polishSpell] nie udalo sie zaladowac slownika (${err.message}) - kontrola ortografii wylaczona`);
  }
}

function ready() {
  if (!initPromise) initPromise = init();
  return initPromise;
}

function isLocalWord(lower) {
  return LOCAL_WORDS.some((w) => lower.startsWith(w));
}

function knownForm(word) {
  if (!checker) return true;
  return checker.spell(word) || checker.spell(word.toLowerCase());
}

function tokenOk(token) {
  const lower = token.toLowerCase();
  if (knownForm(token)) return true;
  if (isLocalWord(lower)) return true;

  if (token.includes('-')) {
    return token.split('-').filter(Boolean).every((part) => {
      const pl = part.toLowerCase();
      return knownForm(part) || COMPOUND_PARTS.includes(pl) || isLocalWord(pl);
    });
  }
  return false;
}

/**
 * Sprawdza tekst slownikiem. Zwraca:
 *   available  - czy slownik dziala (jesli nie, reszta pol jest pusta)
 *   unknownLower - nieznane slowa pisane mala litera. To sa prawdziwe bledy:
 *                  zle formy odmiany i nieistniejace wyrazy.
 *   unknownUpper - nieznane slowa z wielkiej litery. Najczesciej nazwy wlasne,
 *                  wiec traktujemy je tylko jako ostrzezenie, zeby nie
 *                  odrzucac poprawnych tekstow o lokalnych miejscach i ludziach.
 */
async function checkSpelling(text) {
  await ready();
  if (!checker) return { available: false, unknownLower: [], unknownUpper: [], reason: unavailableReason };

  const tokens = String(text)
    .split(/[^\p{L}\-]+/u)
    .filter((t) => t.replace(/-/g, '').length > 2 && !/\d/.test(t));

  const unknownLower = [];
  const unknownUpper = [];
  const seen = new Set();

  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    if (tokenOk(token)) continue;

    // Wyrazy z lacznikiem traktujemy surowo, nawet pisane wielka litera.
    // Wlasnie tedy przeszlo "Niemczyko-polskie": duza litera kazala
    // uznac to za nazwe wlasna. Prawdziwe nazwy z lacznikiem
    // ("Jastrzebie-Zdroj", "XIX-wieczny", "bialo-czerwona") slownik zna
    // w calosci albo po czlonach, wiec tutaj nie trafiaja.
    if (token.includes('-')) {
      unknownLower.push(token);
      continue;
    }

    if (/^\p{Lu}/u.test(token)) unknownUpper.push(token);
    else unknownLower.push(token);
  }

  return { available: true, unknownLower, unknownUpper, reason: null };
}

module.exports = { checkSpelling, COMPOUND_PARTS };
