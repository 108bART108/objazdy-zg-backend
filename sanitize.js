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

  problems.push(...scanTruncatedStart(description));

  return problems;
}

// Wykrywa opis, ktory zaczyna sie w polowie mysli - czyli scraper zgubil
// poczatek tresci. Dokladnie taki blad przeszedl przez wszystkie filtry w
// komunikacie MZK o ul. Zacisze: opis zaczynal sie od slow "w zwiazku z
// powyzszym nastapia zmiany", chociaz zadnego "powyzszego" w appce nie bylo.
// Tresc byla poprawna jezykowo, wiec zaden dotychczasowy filtr nie mial
// podstaw, zeby ja zakwestionowac - a dla czytelnika byla bez sensu.
//
// Dwa sygnaly, oba o wysokiej pewnosci:
//  1. Opis zaczyna sie mala litera. W polskim komunikacie zdanie zaczyna sie
//     wielka litera, wiec mala oznacza uciety poczatek. Wyjatkiem sa nazwy
//     typu "ul." i "al." oraz skroty, ktore dopuszczamy.
//  2. Opis otwiera sie odwolaniem do czegos, czego czytelnik nie widzial
//     ("w zwiazku z powyzszym", "zgodnie z powyzszym", "jak wyzej").
const LOWERCASE_START_OK = /^(ul\.|al\.|pl\.|os\.|dr\.|nr\.?\s|im\.|godz\.|tzw\.|ok\.|ww\.|np\.)/i;
const DANGLING_REFERENCE_RE = /\b(powy[zż]sz\w*|wy[zż]ej\s+wymienion\w*|jak\s+wy[zż]ej|wspomnian\w*\s+wy[zż]ej)\b/i;

function scanTruncatedStart(description) {
  if (!description) return [];
  const problems = [];
  const head = description.slice(0, 60);

  if (/^[a-ząćęłńóśźż]/.test(description) && !LOWERCASE_START_OK.test(description)) {
    problems.push(`opis zaczyna sie mala litera - prawdopodobnie uciety poczatek ("${head.slice(0, 40)}...")`);
  }

  // Odwolanie wstecz w pierwszym zdaniu znaczy, ze brakuje tego, do czego
  // opis sie odwoluje. Dalej w tekscie jest w porzadku - tam "powyzszym"
  // odnosi sie do fragmentu, ktory czytelnik juz przeczytal.
  if (DANGLING_REFERENCE_RE.test(head)) {
    problems.push(`opis zaczyna sie od odwolania do brakujacego fragmentu ("${head.slice(0, 40)}...")`);
  }

  return problems;
}

// Limit dlugosci opisu. Komunikaty MZK zawieraja wstep plus liste zmian dla
// kilku linii naraz i potrafia miec ~600 znakow - przy dawnym limicie 400
// gubily koncowke, czyli najczesciej ostatnia linie autobusowa. Appka i tak
// zwija dlugie opisy do trzech linijek z przyciskiem "pokaz wiecej", wiec
// dluzszy opis nic nie psuje, a nie gubi informacji.
const DESCRIPTION_LIMIT = 600;

// Przycina na granicy zdania albo punktu listy, nigdy w polowie slowa.
// Twarde slice() zostawialo urwane wyrazy w rodzaju "bedzie kursow".
function trimToSentence(text, limit) {
  if (!text || text.length <= limit) return text || '';
  const cut = text.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  if (lastStop > limit * 0.5) return cut.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : limit).trim()}...`;
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
      description: trimToSentence(cleanText(raw.description), DESCRIPTION_LIMIT),
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
