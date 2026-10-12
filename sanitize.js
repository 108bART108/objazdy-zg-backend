// Centralny filtr tresci dla WSZYSTKICH zrodel (ZDW, MZK, ZWiK, Enea, UM RSS).
//
// Powod istnienia: strony zrodlowe to w wiekszosci WordPressy, ktore co jakis
// czas zmieniaja uklad i zaczynaja wklejac przed trescia swoje metadane -
// wzgledna date ("1 godzine temu"), etykiete kategorii ("Uncategorized"),
// "Czytaj wiecej" itd. Kazdy scraper mial wlasne, osobne czyszczenie, wiec
// taka zmiana przechodzila niezauwazona do momentu, az ktos zobaczyl smieci
// w aplikacji. Teraz wszystko przechodzi przez jedno miejsce, niezaleznie od
// tego, ktory scraper wpis wyprodukowal.
//
// Zasada bezpieczenstwa: usuwamy TYLKO to, czego na pewno nie ma w prawdziwej
// tresci komunikatu. Wzgledne daty obcinamy wylacznie z POCZATKU tekstu, bo
// zdanie "awaria trwa juz 3 dni" jest poprawna trescia i nie wolno go ruszyc.

// --- metadane na poczatku tekstu -------------------------------------------

// "1 godzine temu", "3 dni temu", "2 tygodnie temu", "45 minut temu"
const LEADING_AGO_RE = /^\s*\d+\s+\p{L}+\s+temu\s*[,;:·|–—-]*\s*/iu;

// "Dzisiaj o 08:15", "Wczoraj o 16:40", "5 pazdziernika o 09:00"
const LEADING_CLOCK_RE = /^\s*(?:Dzisiaj|Wczoraj|\d{1,2}\s+\p{L}+)\s+o\s+\d{2}:\d{2}\s*[,;:·|–—-]*\s*/iu;

// Etykiety kategorii / breadcrumbs wklejane przed trescia
const LEADING_LABEL_RE = new RegExp(
  '^\\s*(?:'
  + 'Uncategorized|Bez kategorii|Aktualno\\u015bci|Komunikaty|Awarie i remonty'
  + '|Strona g\\u0142\\u00f3wna|Og\\u0142oszenia|Wiadomo\\u015bci|Informacje'
  + '|Bez kategorii'
  + ')\\s*[,;:·|\\u2013\\u2014>\\u00bb/-]*\\s*',
  'iu',
);

const LEADING_RULES = [LEADING_AGO_RE, LEADING_CLOCK_RE, LEADING_LABEL_RE];

// --- smieci, ktore mozna usunac z dowolnego miejsca tekstu -----------------
// Te frazy nie wystepuja w prawdziwych komunikatach o utrudnieniach, wiec
// usuwamy je globalnie, a nie tylko z poczatku.
const GLOBAL_NOISE = [
  /Czytaj (?:więcej|dalej)/gi,
  /Zobacz (?:więcej|także|również)/gi,
  /Dodaj komentarz/gi,
  /Brak komentarzy/gi,
  /Udostępnij(?: na)?/gi,
  /Podziel się/gi,
  /Drukuj stronę|Wersja do druku/gi,
  /Wyślij znajomemu/gi,
  /Powrót do listy|Wróć do listy/gi,
  /Odsłon:\s*\d+/gi,
  /Wyświetleń:\s*\d+/gi,
  /Uncategorized/gi,
  /&nbsp;|&amp;|&quot;|&#\d+;/gi,
];

/**
 * Czysci tekst z metadanych CMS. Metadane z poczatku obcinane sa w PETLI,
 * bo potrafia wystapic jedno po drugim ("1 godzine temu, Uncategorized ...").
 */
function cleanText(input) {
  if (typeof input !== 'string') return '';
  let out = input;

  for (let pass = 0; pass < 6; pass += 1) {
    const before = out;
    for (const re of LEADING_RULES) out = out.replace(re, '');
    if (out === before) break;
  }

  for (const re of GLOBAL_NOISE) out = out.replace(re, ' ');

  return out
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;:·|–—>»/-]+/, '')
    .trim();
}

// --- wykrywanie resztek ----------------------------------------------------
// Jesli po czyszczeniu cos nadal wyglada na metadane albo na uszkodzony wpis,
// zglaszamy to - nie blokujemy publikacji, ale zostawiamy slad w logach
// i w cotygodniowym raporcie healthcheck.

const SUSPICIOUS = [
  { re: /^\s*\d+\s+\p{L}+\s+temu/iu, msg: 'tekst zaczyna sie od wzglednej daty ("X temu")' },
  { re: /^(?:Dzisiaj|Wczoraj)\s+o\s+\d{2}:\d{2}/iu, msg: 'tekst zaczyna sie od godziny publikacji' },
  { re: /uncategorized/i, msg: 'zawiera etykiete "Uncategorized"' },
  { re: /czytaj (?:więcej|dalej)/i, msg: 'zawiera "Czytaj wiecej"' },
  { re: /<[a-z/][^>]*>/i, msg: 'zawiera surowy znacznik HTML' },
  { re: /&(?:nbsp|amp|quot|#\d+);/i, msg: 'zawiera encje HTML' },
  { re: /\{\{|\}\}|\$\{/, msg: 'zawiera nieprzetworzony szablon' },
  { re: /^(?:null|undefined|NaN)$/i, msg: 'tekst to wartosc techniczna (null/undefined)' },
];

/**
 * Sprawdza pojedynczy wpis. Zwraca liste opisow problemow (pusta = OK).
 */
function scanItem(item) {
  const problems = [];
  const title = (item.title || '').trim();
  const description = (item.description || '').trim();

  for (const rule of SUSPICIOUS) {
    if (rule.re.test(description)) problems.push(`opis: ${rule.msg}`);
    if (rule.re.test(title)) problems.push(`tytul: ${rule.msg}`);
  }

  if (!title) problems.push('brak tytulu');
  if (!description) problems.push('brak opisu');
  else if (description.length < 25) problems.push(`opis podejrzanie krotki (${description.length} zn.)`);

  if (title && description && title.toLowerCase() === description.toLowerCase()) {
    problems.push('opis jest identyczny z tytulem');
  }

  return problems;
}

/**
 * Czysci i sprawdza caly zestaw wpisow ze wszystkich zrodel.
 * Zwraca { items, warnings } - items sa juz wyczyszczone i gotowe do zapisu.
 */
function sanitizeItems(rawItems) {
  const items = [];
  const warnings = [];

  for (const raw of rawItems) {
    const item = {
      ...raw,
      title: cleanText(raw.title).slice(0, 300),
      description: cleanText(raw.description).slice(0, 400),
    };

    const problems = scanItem(item);
    if (problems.length) {
      warnings.push({
        source_name: item.source_name || 'nieznane zrodlo',
        category: item.category || '-',
        title: item.title || '(brak tytulu)',
        source_url: item.source_url || '',
        problems,
      });
    }

    // Wpis bez tytulu lub bez opisu jest bezuzyteczny dla uzytkownika -
    // nie zapisujemy go, zeby w aplikacji nie pojawila sie pusta karta.
    if (item.title && item.description) items.push(item);
  }

  return { items, warnings };
}

module.exports = { cleanText, scanItem, sanitizeItems };
