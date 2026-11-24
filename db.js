const Database = require('better-sqlite3');
const path = require('path');
const { szukaj, normalizujKategorie, policzKategorie } = require('./szukanie');
const { podzielWpisy } = require('./widocznosc');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'objazdy.db');

require('fs').mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS utrudnienia (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_url TEXT UNIQUE NOT NULL,
    source_name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT 'drogi',
    title TEXT NOT NULL,
    street TEXT,
    description TEXT,
    published_at TEXT,
    fetched_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE INDEX IF NOT EXISTS idx_utrudnienia_category ON utrudnienia(category);
  CREATE INDEX IF NOT EXISTS idx_utrudnienia_published ON utrudnienia(published_at DESC);

  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT UNIQUE NOT NULL,
    subscription_json TEXT NOT NULL,
    categories TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS daily_fact (
    fact_date TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS local_ads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    business_name TEXT NOT NULL,
    tagline TEXT NOT NULL,
    link_url TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Stan kazdego zrodla danych. Dzieki temu wiemy, ze np. MZK od dwoch dni
  -- nie zwraca ani jednego wpisu - appka wyglada wtedy normalnie, wiec bez
  -- takiego zapisu problem potrafi zostac niezauwazony przez wiele dni.
  CREATE TABLE IF NOT EXISTS source_health (
    source TEXT PRIMARY KEY,
    last_count INTEGER NOT NULL DEFAULT 0,
    empty_streak INTEGER NOT NULL DEFAULT 0,
    last_ok_at TEXT,
    alerted INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Dziennik kazdej proby wysylki powiadomien. Bez tego nie da sie
  -- stwierdzic "push nie dziala od tygodnia" - a wlasnie tak przebiegla
  -- awaria, przy ktorej wpisy pojawialy sie w appce, powiadomienia nie
  -- wychodzily, i nikt sie o tym nie dowiedzial, bo system nie krzyczal.
  -- kind: 'wysylka' (wynik cyklu) albo 'alarm' (zgloszono cisze push).
  CREATE TABLE IF NOT EXISTS push_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL DEFAULT 'wysylka',
    kandydatow INTEGER NOT NULL DEFAULT 0,
    dostarczono INTEGER NOT NULL DEFAULT 0,
    bledow INTEGER NOT NULL DEFAULT 0,
    pominieto_stare INTEGER NOT NULL DEFAULT 0,
    pominieto_kategorie INTEGER NOT NULL DEFAULT 0,
    szczegoly TEXT,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Drobne ustawienia techniczne, ktore musza przetrwac restart serwera.
  -- Render restartuje usluge przy kazdym wdrozeniu, wiec wszystko trzymane
  -- tylko w pamieci zaczyna sie wtedy od zera - lacznie z wiedza o tym,
  -- czego juz probowalismy bez skutku.
  CREATE TABLE IF NOT EXISTS app_state (
    klucz TEXT PRIMARY KEY,
    wartosc TEXT,
    updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE TABLE IF NOT EXISTS health_reports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    report TEXT NOT NULL,
    has_problem INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Anonimowe liczniki uzycia appki. Jeden wiersz = jedna sesja, zapisany
  -- raz, gdy mieszkaniec zamyka appke albo przechodzi do innej.
  --
  -- CZEGO TU NIE MA I NIGDY NIE BEDZIE: adresu IP, identyfikatora
  -- urzadzenia, ciasteczka, lokalizacji - niczego, co pozwoliloby powiazac
  -- dwie sesje z ta sama osoba. Zapisujemy wylacznie liczby.
  --
  -- PO CO: zeby odpowiedziec liczbami na pytanie, czy wyszukiwarka skraca
  -- sesje i odbiera odslony reklamodawcom. Rozstrzyga o tym porownanie
  -- sesji Z wyszukiwaniem i BEZ niego - stad te dwie kolumny obok siebie.
  CREATE TABLE IF NOT EXISTS metryki_sesji (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    czas_s INTEGER NOT NULL DEFAULT 0,
    wyszukiwan INTEGER NOT NULL DEFAULT 0,
    pustych INTEGER NOT NULL DEFAULT 0,
    odslon_reklam INTEGER NOT NULL DEFAULT 0,
    przelaczen INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Frazy, ktore NIE DALY zadnego wyniku. To najcenniejszy sygnal, jaki
  -- mozna stad wyciagnac: mowi, czego mieszkancy szukaja, a czego appka nie
  -- pokrywa. Jesli zacznie sie tu powtarzac "Sulechow", bedzie to argument
  -- za dolozeniem tego zrodla mocniejszy niz jakiekolwiek moje przypuszczenie.
  -- Zapisujemy sama fraze, bez zadnego powiazania z osoba czy sesja.
  CREATE TABLE IF NOT EXISTS metryki_pytania (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fraza TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  -- Jeden wiersz = jeden reklamodawca zobaczony w jednej sesji. Nie liczba
  -- wyswietlen, tylko liczba OSOB, ktore mialy ta reklame na ekranie.
  --
  -- Taka liczba da sie obronic przy rozmowie z klientem: "Twoja reklama byla
  -- widoczna u 49 osob w ciagu dwoch tygodni" znaczy dokladnie to, co mowi.
  -- Poprzedni licznik dawal liczbe dziesieciokrotnie wyzsza, ktora przy
  -- pierwszym pytaniu klienta okazalaby sie liczba RYSOWAN strony.
  --
  -- Zapisujemy id reklamy (zeby zmiana nazwy firmy nie rozbila historii)
  -- oraz nazwe z chwili wyswietlenia (zeby raport dalo sie przeczytac po
  -- usunieciu reklamy). Nadal nic o osobie: ani adresu, ani ciasteczka.
  CREATE TABLE IF NOT EXISTS metryki_reklam (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    reklama_id INTEGER,
    nazwa TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );

  CREATE INDEX IF NOT EXISTS idx_metryki_reklam_czas ON metryki_reklam(created_at DESC);
`);

const migrations = [
  'ALTER TABLE local_ads ADD COLUMN expires_at TEXT',
  'ALTER TABLE local_ads ADD COLUMN starts_at TEXT',
  'ALTER TABLE local_ads ADD COLUMN reminder_sent INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE utrudnienia ADD COLUMN event_date TEXT',
  'ALTER TABLE utrudnienia ADD COLUMN needs_review INTEGER NOT NULL DEFAULT 0',
  'ALTER TABLE utrudnienia ADD COLUMN review_reasons TEXT',
  // Kiedy OSTATNI raz widzielismy ten wpis u zrodla. Istniejace fetched_at
  // sie do tego nie nadaje: ustawia sie tylko przy wstawianiu i nigdy nie
  // odswieza, wiec znaczy "pierwszy raz widziany". Bez last_seen nie da sie
  // stwierdzic, ze ZWiK usunal juz komunikat o awarii - czyli ze sprawa
  // jest zamknieta. Patrz widocznosc.js.
  'ALTER TABLE utrudnienia ADD COLUMN last_seen TEXT',
  // Licznik odslon reklam liczyl do 24.11.2026 cos innego, niz nazywal:
  // WSTAWIENIA pola reklamowego do strony. Appka rysuje liste od nowa przy
  // kazdym przelaczeniu zakladki i przy kazdym wyszukiwaniu, a w kazdym
  // rysowaniu wstawia pole co drugi wpis - wiec jedna osoba potrafila
  // "wygenerowac" trzydziesci odslon, nie przewijajac ekranu. Liczyly sie
  // tez pola PUSTE, bez zadnej reklamy w srodku, i takie, do ktorych
  // mieszkaniec nigdy nie doscrollowal.
  //
  // Od wersji 2 liczymy inaczej: reklama musi naprawde pojawic sie na
  // ekranie, i liczy sie raz na sesje na reklamodawce. Ta kolumna oddziela
  // jedne dane od drugich, zeby panel nie zsumowal po cichu liczb, ktore
  // znacza co innego - tej liczby wlasciciel appki uzywa wobec klientow.
  'ALTER TABLE metryki_sesji ADD COLUMN wersja_licznika INTEGER NOT NULL DEFAULT 1',
  'ALTER TABLE daily_fact ADD COLUMN source_url TEXT',
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (err) { /* kolumna juz istnieje */ }
}

// Wpisy, ktore byly w bazie przed wprowadzeniem last_seen, dostaja znacznik
// "widziany teraz" - a NIE swoje fetched_at, choc kusi.
//
// Powod jest praktyczny. Przy zimnym starcie gminyCms pobiera tylko trzy
// podstrony na gmine, wiec czesc wpisow Swidnicy i Otynia nie odswiezy sie
// w pierwszym cyklu. Gdybysmy wpisali im stare fetched_at, regula
// nieobecnosci zdjelaby je od razu po wdrozeniu i wrocilyby dopiero po
// kilkudziesieciu minutach - mignieciem, ktorego nikt by nie zrozumial.
//
// Kosztuje to jedna dobe zwloki, zanim naprawde porzucone wpisy zaczna
// znikac. Lepsze niz znikanie wpisow, ktore sa w porzadku.
try {
  const uzupelnione = db.prepare(
    "UPDATE utrudnienia SET last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE last_seen IS NULL",
  ).run();
  if (uzupelnione.changes) {
    console.log(`[db] uzupelniono last_seen dla ${uzupelnione.changes} wpisow sprzed tej zmiany`);
  }
} catch (err) {
  console.error('[db] nie udalo sie uzupelnic last_seen:', err.message);
}

// Jednorazowe naprawienie juz istniejacych wpisow, ktore zdazyly zapisac
// sie z bledna, przyszla data (np. zaplanowana godzina wylaczenia pradu)
// jako published_at - zanim wprowadzilismy sanitizePublishedAt(). Mechanizm
// "samoleczacy" (COALESCE) sam z siebie by tego NIE naprawil, bo dla tych
// wpisow zawsze bedzie brakowac nowej, pewnej daty (Enea zawsze podaje
// date zdarzenia w przyszlosci) - wiec bez tej jednorazowej korekty stara,
// bledna wartosc zostalaby zachowana w nieskonczonosc.
try {
  const fixed = db.prepare(`
    UPDATE utrudnienia
    SET published_at = fetched_at
    WHERE published_at IS NOT NULL
      AND julianday(published_at) - julianday('now') > 1
  `).run();
  if (fixed.changes > 0) {
    console.log(`[db] naprawiono ${fixed.changes} wpisow z blednie zapisana data w przyszlosci`);
  }
} catch (err) {
  console.error('[db] blad jednorazowej naprawy dat:', err.message);
}

// Ponizej jakiej dlugosci opisu NIE wolno uznawac dwoch wpisow za ten sam
// komunikat tylko dlatego, ze maja identyczny opis. Krotki opis to zwykle
// powtorzony tytul (tak dziala awaryjne "opis = tytul"), a dwa rozne
// zamkniecia drog moga miec przypadkiem takie samo krotkie zdanie.
// Identyczny DLUGI tekst to natomiast pewny znak, ze to jedno zawiadomienie.
const MIN_OPIS_DUPLIKATU = 200;

// Zrodla, dla ktorych wolno stosowac regule 2 ("ta sama tresc pod innym
// tytulem"). Lista, a nie "wszystkie", bo 22.11.2026 ta regula wlaczona
// globalnie ukryla 14 PRAWDZIWYCH powiadomien o wylaczeniach pradu Enei:
// "Obszar Czerwiensk dzisiaj", "Obszar Swidnica dzisiaj", "Obszar Zielona
// Gora dzisiaj"... Enea opisuje to samo wylaczenie pod kilkoma naglowkami
// obszarow (w logu byl nawet "Obszar Swidnica, Zielona Gora dzisiaj") i tresc
// jest wtedy identyczna - ale to NIE duplikat: mieszkaniec Swidnicy i
// mieszkaniec Zielonej Gory musza zobaczyc to ostrzezenie kazdy u siebie,
// bo wlasnie naglowek obszaru mowi im, ze sprawa dotyczy ich.
// Prog 200 znakow przed tym nie uchronil, bo listy ulic sa dlugie.
//
// Wniosek: czy identyczna tresc znaczy "ten sam komunikat" zalezy od tego,
// JAK dane zrodlo publikuje - wiec to musi byc decyzja per zrodlo, podjeta
// po zobaczeniu prawdziwych danych, a nie regula na wszystko.
const REGULA_TRESCI_ZRODLA = ['PZZD Gorzykowo'];

// Bezpiecznik. Regula 2 nigdy nie powinna ukryc wielu wpisow naraz - PZZD
// publikuje szesc komunikatow w roku. Jesli chce ukryc wiecej, to znaczy, ze
// sie myli, i lepiej nie ukryc nic niz schowac ostrzezenia przed ludzmi.
// Dokladnie tego brakowalo, gdy regula zabrala 14 wpisow Enei za jednym razem.
const MAX_UKRYTYCH_REGULA_TRESCI = 3;

// Tresc ostrzezen bezpiecznika juz wypisanych w tym procesie.
const zgloszoneBezpieczniki = new Set();

/**
 * Dezaktywuje wpisy, ktore sa tym samym komunikatem zapisanym dwa razy pod
 * roznymi source_url. Zostaje wpis z najnizszym id (odkryty pierwszy),
 * reszta dostaje active = 0 - nie usuwamy, zeby nie stracic historii.
 *
 * Dwie reguly:
 *
 *  1. Ten sam tytul I opis w tej samej kategorii. Tak wyglada typowy
 *     przypadek, gdy zrodlo publikuje komunikat dwa razy z niewidoczna
 *     roznica w otaczajacym tekscie, przez co powstaja dwa source_url.
 *
 *  2. Ten sam DLUGI opis w tym samym zrodle i kategorii, ale pod INNYM
 *     tytulem. Tej reguly dotad nie bylo i dlatego 22.11.2026 PZZD wstawil
 *     do appki dwa razy to samo zamkniecie drogi 1189F w Karszynie - raz
 *     jako "Zamkniecie drogi powiatowej 1189F w m. Karszyn", raz jako
 *     "ZAMKNIECIE DROGI POWIATOWEJ NR 1189F W M. KARSZYN 25.08.2026 r.-
 *     26.08.2026r.". Oba wpisy mialy identyczna tresc (566 znakow), ale
 *     rozne tytuly, wiec klucz z reguly 1 ich nie zlapal. Dla czytelnika
 *     to byl po prostu ten sam komunikat dwa razy pod rzad.
 *     Zawezamy regule do jednego zrodla, zeby nie wyciszyc sytuacji, w
 *     ktorej dwie instytucje niezaleznie informuja o tym samym - to jest
 *     cenna informacja, nie duplikat.
 *
 * Wolamy to przy starcie ORAZ po kazdym cyklu scrapowania. Upsert ustawia
 * active = 1, wiec dezaktywowany duplikat wraca na chwile przy kazdym
 * cyklu - i dlatego sprzatanie musi iss PO zapisie, a nie tylko raz.
 */
function dezaktywujDuplikatyTresci() {
  const rows = db.prepare(
    'SELECT id, source_name, category, title, description FROM utrudnienia WHERE active = 1 ORDER BY id',
  ).all();

  const { duplikaty, wstrzymane } = wskazDuplikaty(rows);

  // Tu, a nie w samej funkcji decyzyjnej - bo tylko tutaj wiemy, ze patrzymy
  // na prawdziwa baze, a nie na wiersze podstawione przez test.
  if (wstrzymane.length) {
    const opisy = wstrzymane.map((d) => `"${d.title}"`).join(', ');
    const tresc = `[db] UWAGA: regula "ta sama tresc pod innym tytulem" chciala ukryc `
      + `${wstrzymane.length} wpisow (limit ${MAX_UKRYTYCH_REGULA_TRESCI}) - NIE ukrywam zadnego. `
      + `Tyle naraz znaczy, ze regula sie myli, a nie ze zrodlo sie powtarza. Chodzilo o: ${opisy}`;
    // Raz na uruchomienie serwera, a nie co dziesiec minut.
    if (!zgloszoneBezpieczniki.has(tresc)) {
      zgloszoneBezpieczniki.add(tresc);
      console.warn(tresc);
    }
  }

  if (!duplikaty.length) return { zdezaktywowanych: 0, szczegoly: [] };

  const placeholders = duplikaty.map(() => '?').join(',');
  db.prepare(`UPDATE utrudnienia SET active = 0 WHERE id IN (${placeholders})`)
    .run(...duplikaty.map((d) => d.id));

  return { zdezaktywowanych: duplikaty.length, szczegoly: duplikaty };
}

/**
 * Sama decyzja "ktore wiersze sa duplikatami" - bez bazy, zeby dala sie
 * sprawdzic testem przy starcie serwera i w codziennym przegladzie.
 * Wiersze musza przyjsc posortowane po id rosnaco: zostaje pierwszy.
 */
function wskazDuplikaty(rows) {
  const normalize = (t) => (t || '').toLowerCase().replace(/\s+/g, ' ').replace(/[.,;:…]+$/, '').trim();

  const poTytuleIOpisie = new Map();
  const poDlugimOpisie = new Map();
  const duplikaty = [];
  const zRegulyTresci = [];

  for (const row of rows) {
    const tytul = normalize(row.title);
    const opis = normalize(row.description);

    const klucz1 = `${row.category}||${tytul}||${opis}`;
    if (poTytuleIOpisie.has(klucz1)) {
      duplikaty.push({ id: row.id, title: row.title, regula: 'ten sam tytul i opis' });
      continue;
    }
    poTytuleIOpisie.set(klucz1, row.id);

    if (!REGULA_TRESCI_ZRODLA.includes(row.source_name)) continue;

    if (opis.length >= MIN_OPIS_DUPLIKATU) {
      const klucz2 = `${row.source_name}||${row.category}||${opis}`;
      if (poDlugimOpisie.has(klucz2)) {
        zRegulyTresci.push({ id: row.id, title: row.title, regula: 'ta sama tresc pod innym tytulem' });
        continue;
      }
      poDlugimOpisie.set(klucz2, row.id);
    }
  }

  // Bezpiecznik: lepiej pokazac duplikat niz schowac ostrzezenia.
  //
  // Ta funkcja NICZEGO NIE WYPISUJE - i to nie jest drobiazg stylistyczny.
  // Przez chwile bezpiecznik wolal tu console.warn, a poniewaz te sama
  // funkcje wywoluje test w kontroli startowej, do produkcyjnego logu trafialo
  // przy kazdym starcie serwera ostrzezenie o wpisach "B", "C", "D", "E", "F",
  // czyli o danych testowych. Wygladalo to jak prawdziwa awaria i poslalo nas
  // oboje w pogon za duchem. Decyzje podejmuje ta funkcja, a raportuje ten,
  // kto ja wola - bo tylko on wie, czy pracuje na prawdziwej bazie.
  if (zRegulyTresci.length > MAX_UKRYTYCH_REGULA_TRESCI) {
    return { duplikaty, wstrzymane: zRegulyTresci };
  }

  return { duplikaty: [...duplikaty, ...zRegulyTresci], wstrzymane: [] };
}

// Sprzatanie przy starcie serwera.
try {
  const { zdezaktywowanych, szczegoly } = dezaktywujDuplikatyTresci();
  if (zdezaktywowanych) {
    console.log(`[db] zdezaktywowano ${zdezaktywowanych} zdublowanych wpisow (ta sama tresc, rozne source_url)`);
    for (const d of szczegoly) {
      console.log(`[db]   duplikat: "${d.title}" (${d.regula})`);
    }
  }
} catch (err) {
  console.error('[db] blad sprzatania duplikatow:', err.message);
}

// WAZNE: published_at uzywa COALESCE w dwoch miejscach - to jest mechanizm
// "samoleczacy" zapobiegajacy powrotowi bledu "data = moment scrapowania":
//  - Przy NOWYM wpisie (INSERT): jesli scraper nie podal pewnej daty
//    (published_at = null), uzywamy biezacej daty jako jedynego rozsadnego
//    przyblizenia (pierwszy raz widzimy ten wpis, wiec to najlepsze co
//    mamy).
//  - Przy JUZ ISTNIEJACYM wpisie (UPDATE): jesli scraper w tym przebiegu
//    NIE podal pewnej daty, zachowujemy date, ktora JUZ byla zapisana w
//    bazie, zamiast ja nadpisywac domyslnym "teraz". Dzieki temu nawet
//    jesli parsowanie daty w ktoryms scraperze znowu kiedys zawiedzie,
//    appka nie zacznie znowu pokazywac wszystkim wpisom dzisiejszej daty -
//    po prostu zachowa ostatnia znana, dobra wartosc.
const upsertStmt = db.prepare(`
  INSERT INTO utrudnienia (source_url, source_name, category, title, street, description, published_at, event_date, needs_review, review_reasons, last_seen)
  VALUES (@source_url, @source_name, @category, @title, @street, @description, COALESCE(@published_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), @event_date, @needs_review, @review_reasons, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  ON CONFLICT(source_url) DO UPDATE SET
    -- Kategoria MUSI sie aktualizowac razem z reszta. Bez tej linii wpis raz
    -- zle zaszufladkowany zostawal w zlej zakladce na zawsze, nawet po
    -- poprawieniu klasyfikatora - bo przy kolejnym scrapowaniu nadpisywalismy
    -- tytul i opis, ale kategorie zostawialismy stara. Tak wlasnie utknal
    -- komunikat "Budowa sieci wodociagowej na al. Konstytucji 3 Maja"
    -- w zakladce "woda" (12.11.2026). Teraz kazda poprawka w classify.js
    -- naprawia rowniez wpisy, ktore juz sa w bazie.
    category = excluded.category,
    title = excluded.title,
    street = excluded.street,
    description = excluded.description,
    published_at = COALESCE(@published_at, utrudnienia.published_at),
    event_date = COALESCE(@event_date, utrudnienia.event_date),
    needs_review = excluded.needs_review,
    review_reasons = excluded.review_reasons,
    -- MUSI sie odswiezac przy kazdym zapisie - na tym opiera sie cala
    -- regula "zrodlo juz tego nie wymienia, czyli sprawa zamknieta".
    last_seen = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    active = 1
`);

const existsStmt = db.prepare('SELECT 1 FROM utrudnienia WHERE source_url = ?');

// Data w przyszlosci (ponad dobe od teraz) NIE jest uzywana jako
// published_at. Taka data zazwyczaj oznacza zaplanowane, jednorazowe
// wydarzenie (np. godzina planowanego wylaczenia pradu w przyszlym
// tygodniu), a nie faktyczna date publikacji/odkrycia informacji przez
// nasz system. W takim przypadku karta w appce ma pokazywac date
// DZISIEJSZA (kiedy dowiedzielismy sie o tym wydarzeniu) - a szczegoly
// czasowe samego wydarzenia i tak zostaja w opisie tekstowym wpisu.
// Dziala to jednolicie dla wszystkich zrodel, bez potrzeby osobnej
// logiki w kazdym scraperze.
function sanitizePublishedAt(publishedAt) {
  if (!publishedAt) return null;
  const parsed = new Date(publishedAt);
  if (isNaN(parsed.getTime())) return null;
  const oneDayFromNow = Date.now() + 86400000;
  if (parsed.getTime() > oneDayFromNow) return null;
  return publishedAt;
}

function upsertMany(items) {
  const newItems = [];
  const flaggedItems = [];
  const tx = db.transaction((rows) => {
    for (const row of rows) {
      const alreadyExists = existsStmt.get(row.source_url);
      if (!alreadyExists) newItems.push(row);
      if (row.needs_review) flaggedItems.push(row);
      upsertStmt.run({
        ...row,
        published_at: sanitizePublishedAt(row.published_at),
        event_date: row.event_date || null,
        needs_review: row.needs_review ? 1 : 0,
        review_reasons: row.review_reasons ? row.review_reasons.join('; ') : null,
      });
    }
  });
  tx(items);
  return { count: items.length, newItems, flaggedItems };
}

// Opisy juz zapisanych wpisow, po adresach zrodlowych. Pozwala scraperom
// NIE pobierac po raz kolejny artykulu, ktorego tresc juz znamy.
function getDescriptionsByUrls(urls) {
  if (!urls || !urls.length) return new Map();
  const placeholders = urls.map(() => '?').join(',');
  const rows = db
    .prepare(`SELECT source_url, description FROM utrudnienia WHERE source_url IN (${placeholders})`)
    .all(...urls);
  return new Map(rows.map((r) => [r.source_url, r.description]));
}

// Ile wierszy wyciagamy z bazy, gdy mieszkaniec czegos szuka. Filtr polski
// dziala w pamieci, wiec musi dostac szerszy zestaw niz sama pierwsza strona.
// Przy kilkudziesieciu aktywnych wpisach to i tak caly stan appki; gdyby
// kiedys bylo ich dziesiatki tysiecy, trzeba bedzie wrocic do indeksu w bazie.
const LIMIT_DO_SZUKANIA = 500;

// Nieznana kategoria to blad frontendu, nie mieszkanca - zglaszamy ja raz na
// uruchomienie, zeby nie zasypac logu przy kazdym odswiezeniu listy.
const zgloszoneKategorie = new Set();
function ostrzezOKategorii(kategoria) {
  const tresc = `[db] nieznana kategoria "${kategoria}" - pokazuje wszystkie wpisy`;
  if (zgloszoneKategorie.has(tresc)) return;
  zgloszoneKategorie.add(tresc);
  console.warn(tresc);
}

/**
 * Ile wpisow pasuje do frazy w kazdej kategorii osobno - niezaleznie od tego,
 * w ktorej zakladce stoi mieszkaniec. Dzieki temu appka moze powiedziec
 * "w drogach nic nie ma, ale sa 2 wyniki w wodociagach".
 */
function policzWKategoriach({ search } = {}) {
  if (!search || !String(search).trim()) return null;
  const wiersze = db.prepare(
    'SELECT * FROM utrudnienia WHERE active = 1 AND needs_review = 0 '
    + 'ORDER BY published_at DESC LIMIT @limit',
  ).all({ limit: LIMIT_DO_SZUKANIA });
  // Te same wpisy, ktore widzi lista - inaczej appka napisalaby "2 wyniki
  // w wodociagach", a po przejsciu do zakladki pokazalaby jeden.
  const { widoczne } = podzielWpisy(wiersze);
  return policzKategorie(widoczne, search);
}

function listUtrudnienia({ category, search, limit = 50 } = {}) {
  // needs_review = 0: appka pokazuje tylko wpisy, ktore przeszly
  // automatyczne sprawdzenie jakosci (qualityCheck) bez zastrzezen.
  // Nie ma tu zadnego recznego kroku - wpis albo przechodzi test przy
  // scrapowaniu, albo czeka na kolejny cykl, w ktorym scraper moze
  // wyciagnac lepsza tresc (np. po naprawieniu ekstrakcji zrodla).
  let query = 'SELECT * FROM utrudnienia WHERE active = 1 AND needs_review = 0';
  const params = {};

  // Kategorie sprowadzamy do nazwy z bazy. Wczesniej porownanie bylo
  // doslowne, wiec "ALL", "Drogi", a zwlaszcza "wodociągi" i "prąd" pisane
  // tak, jak nazywaja sie ZAKLADKI w appce, po cichu zwracaly pusta liste -
  // czyli ekran nie do odroznienia od "nie ma zadnych utrudnien".
  const { kategoria, rozpoznana } = normalizujKategorie(category);
  if (!rozpoznana) ostrzezOKategorii(category);
  if (kategoria) {
    query += ' AND category = @category';
    params.category = kategoria;
  }
  // UWAGA: szukania NIE robimy juz w SQL. Powod jest konkretny i sprawdzony
  // na prawdziwych wpisach appki: LIKE w SQLite rozroznia wielkosc liter
  // tylko dla ASCII i nie sprowadza ogonkow do liter bez ogonkow. Z 21
  // zapytan wpisanych tak, jak pisze je mieszkaniec na telefonie, dzialalo
  // 13 - a wsrod niedzialajacych byly "Dabrowskiego", "Ploty", "jasinskiego"
  // i "swidnica". Czyli kto nie stawia ogonkow, nie znajduje WLASNEJ ulicy.
  // Dopasowanie po polsku robi szukanie.js, juz po wyjeciu wierszy z bazy.
  // Przy kilkudziesieciu aktywnych wpisach to natychmiastowe.
  // Sortowanie: ZAWSZE od najnowiej opublikowanego wpisu do najstarszego,
  // niezaleznie od tego czy wpis ma zaplanowana przyszla event_date.
  // event_date sluzy WYLACZNIE do wyswietlenia zoltej plakietki
  // "Dzisiaj/Jutro/za X dni" na karcie - nie zmienia kolejnosci listy.
  // (Wczesniej wpisy z przyszla event_date szly na sam gore, co przy
  // bledzie parsowania daty potrafilo wywindowac stary wpis ponad nowsze
  // - stąd ta zmiana.)
  query += ' ORDER BY published_at DESC LIMIT @limit';

  // Z bazy bierzemy SZERZEJ, niz prosi appka, bo filtry dzialaja dopiero
  // potem - i dotyczy to dwoch rzeczy naraz:
  //  - szukania: inaczej szukalibysmy wylacznie wsrod pierwszych 50 wpisow
  //    i starsza awaria na tej samej ulicy nigdy by sie nie pokazala;
  //  - wygasania: gdyby z bazy wyszlo dokladnie 50 wpisow, a dziesiec z nich
  //    okazalo sie nieaktualnych, appka dostalaby 40 i nie dolozylaby
  //    brakujacych, choc leza w bazie.
  // Aktywnych wpisow jest kilkadziesiat, wiec to i tak natychmiastowe.
  params.limit = Math.max(limit, LIMIT_DO_SZUKANIA);

  const wiersze = db.prepare(query).all(params);

  // Zakonczone zdarzenia znikaja z appki - patrz widocznosc.js. Nie sa
  // kasowane ani oznaczane jako nieaktywne: to filtr przy odczycie, wiec
  // w panelu admina widac caly stan faktyczny.
  const { widoczne } = podzielWpisy(wiersze);

  if (!search) return widoczne.slice(0, limit);
  return szukaj(widoczne, search).slice(0, limit);
}

function getDailyFact(date) {
  return db.prepare('SELECT * FROM daily_fact WHERE fact_date = ?').get(date);
}

function deleteDailyFact(date) {
  db.prepare('DELETE FROM daily_fact WHERE fact_date = ?').run(date);
}

// sourceUrl - zweryfikowany link do zrodla ciekawostki (moze byc null
// dla starszych wpisow sprzed wprowadzenia zrodel).
function saveDailyFact(date, content, sourceUrl = null) {
  db.prepare(`
    INSERT INTO daily_fact (fact_date, content, source_url) VALUES (@date, @content, @sourceUrl)
    ON CONFLICT(fact_date) DO UPDATE SET content = excluded.content, source_url = excluded.source_url
  `).run({ date, content, sourceUrl });
}

function getRecentFacts(limit = 20) {
  return db.prepare('SELECT content FROM daily_fact ORDER BY fact_date DESC LIMIT ?')
    .all(limit)
    .map((r) => r.content);
}

// Najnowsza zapisana ciekawostka (niezaleznie od daty). Sluzy do tego, by
// przy braku dzisiejszej tresci pokazac uzytkownikowi od reki wczorajsza,
// zamiast kazac mu czekac na wygenerowanie nowej.
// Zapisuje wynik jednego cyklu dla danego zrodla i zwraca jego stan:
// ile cykli z rzedu bylo pustych i czy wyslano juz o tym alert.
function recordSourceResult(source, count) {
  const previous = db.prepare('SELECT * FROM source_health WHERE source = ?').get(source);
  const emptyStreak = count > 0 ? 0 : (previous ? previous.empty_streak : 0) + 1;
  const alerted = count > 0 ? 0 : (previous ? previous.alerted : 0);
  const lastOkAt = count > 0 ? new Date().toISOString() : (previous ? previous.last_ok_at : null);

  db.prepare(`
    INSERT INTO source_health (source, last_count, empty_streak, last_ok_at, alerted, updated_at)
    VALUES (@source, @count, @emptyStreak, @lastOkAt, @alerted, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(source) DO UPDATE SET
      last_count = excluded.last_count,
      empty_streak = excluded.empty_streak,
      last_ok_at = excluded.last_ok_at,
      alerted = excluded.alerted,
      updated_at = excluded.updated_at
  `).run({ source, count, emptyStreak, lastOkAt, alerted });

  return {
    emptyStreak,
    alreadyAlerted: !!alerted,
    lastOkAt,
    wasBroken: !!(previous && previous.alerted),
  };
}

// Oznacza, ze alert o tym zrodle zostal juz wyslany - zeby nie powtarzac
// go przy kazdym cyklu scrapowania.
function markSourceAlerted(source) {
  db.prepare('UPDATE source_health SET alerted = 1 WHERE source = ?').run(source);
}

function listSourceHealth() {
  return db.prepare('SELECT * FROM source_health ORDER BY source').all();
}

// --- Dziennik powiadomien push ---

function recordPushAttempt(dane) {
  db.prepare(`
    INSERT INTO push_log (kind, kandydatow, dostarczono, bledow, pominieto_stare, pominieto_kategorie, szczegoly)
    VALUES (@kind, @kandydatow, @dostarczono, @bledow, @pominietoStare, @pominietoKategorie, @szczegoly)
  `).run({
    kind: dane.kind || 'wysylka',
    kandydatow: dane.kandydatow || 0,
    dostarczono: dane.dostarczono || 0,
    bledow: dane.bledow || 0,
    pominietoStare: dane.pominietoStare || 0,
    pominietoKategorie: dane.pominietoKategorie || 0,
    szczegoly: dane.szczegoly || null,
  });
}

// Sprawdza, czy appka nie "zamilkla": czy do bazy trafiaja nowe wpisy,
// a jednoczesnie nie wychodzi ANI JEDNO powiadomienie.
//
// To test objawu, nie konkretnej przyczyny - i o to chodzi. Awaria, ktora
// to wywolala, wynikala ze zbyt waskiego filtra swiezosci, ale dokladnie
// tak samo wygladalaby przy braku kluczy VAPID, bledzie w kodzie wysylki,
// czy gdyby wszyscy sie wypisali. Kazdy z tych przypadkow zostanie tu
// wychwycony, takze taki, ktorego dzisiaj nie przewidujemy.
const PUSH_SILENCE_DAYS = 7;
const PUSH_SILENCE_MIN_ITEMS = 5;
const PUSH_ALARM_COOLDOWN_DAYS = 7;

// Od kiedy dziennik push w ogole zbiera dane. Bez tego statystyki
// porownywalyby wpisy z 7 dni z dziennikiem zalozonym godzine temu i
// pokazywaly "0 wyslanych powiadomien" jako awarie, choc to tylko brak
// historii. Znacznik zakladany jest przy pierwszym starcie po wdrozeniu.
function ensurePushLogStarted() {
  const istnieje = db.prepare('SELECT 1 FROM push_log LIMIT 1').get();
  if (!istnieje) {
    db.prepare("INSERT INTO push_log (kind, szczegoly) VALUES ('start', 'poczatek zbierania danych o powiadomieniach')").run();
  }
}

function getPushLogStart() {
  const r = db.prepare('SELECT created_at FROM push_log ORDER BY id ASC LIMIT 1').get();
  return r ? r.created_at : null;
}

// Czy dziennik zbiera dane wystarczajaco dlugo, by jego cisza cokolwiek
// znaczyla.
function pushLogDojrzaly(dni) {
  const start = getPushLogStart();
  if (!start) return false;
  const wiek = Date.now() - new Date(start).getTime();
  return wiek >= dni * 86400000;
}

function checkPushSilence() {
  const od = new Date(Date.now() - PUSH_SILENCE_DAYS * 86400000).toISOString();

  const noweWpisy = db.prepare(
    'SELECT COUNT(*) AS n FROM utrudnienia WHERE fetched_at >= ?'
  ).get(od).n;

  const wyslane = db.prepare(
    "SELECT COALESCE(SUM(dostarczono), 0) AS n FROM push_log WHERE kind = 'wysylka' AND created_at >= ?"
  ).get(od).n;

  const subskrybenci = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n;

  const stan = { noweWpisy, wyslane, subskrybenci, cisza: false, powod: null };

  // Swiezo zalozony dziennik nie moze byc dowodem na awarie - przez
  // pierwsze dni po wdrozeniu po prostu nie ma jeszcze z czym porownywac.
  if (!pushLogDojrzaly(PUSH_SILENCE_DAYS)) return stan;

  // Bez zapisanych urzadzen cisza jest poprawna - nie ma do kogo wysylac.
  if (!subskrybenci) return stan;
  if (noweWpisy < PUSH_SILENCE_MIN_ITEMS) return stan;
  if (wyslane > 0) return stan;

  // Nie powtarzamy tego samego alarmu codziennie.
  const ostatniAlarm = db.prepare(
    "SELECT created_at FROM push_log WHERE kind = 'alarm' ORDER BY id DESC LIMIT 1"
  ).get();
  if (ostatniAlarm) {
    const wiek = Date.now() - new Date(ostatniAlarm.created_at).getTime();
    if (wiek < PUSH_ALARM_COOLDOWN_DAYS * 86400000) return stan;
  }

  stan.cisza = true;
  stan.powod = `W ciagu ${PUSH_SILENCE_DAYS} dni do appki trafilo ${noweWpisy} nowych wpisow, `
    + `ale nie wyszlo ani jedno powiadomienie (${subskrybenci} zapisanych urzadzen).`;
  return stan;
}

// Podsumowanie dla panelu admina: ile powiadomien wyszlo w ostatnich dniach.
// ======================= ANONIMOWE LICZNIKI UZYCIA ==========================

// Granice rozsadku dla danych przychodzacych z appki. Endpoint jest publiczny,
// wiec przyjmujemy, ze moze do niego trafic cokolwiek - od pomylki w kodzie
// po celowe smieci. Wartosci spoza zakresu przycinamy, zamiast zapisywac
// liczby, ktore pozniej wykrzywialyby srednie.
const MAX_CZAS_SESJI_S = 4 * 3600;     // dluzsza sesja to zapomniana karta
const MAX_LICZNIK = 500;
const MIN_CZAS_SESJI_S = 2;            // ponizej to zwykle przeladowanie strony
const MAX_DL_FRAZY = 40;
const MAX_FRAZ_NA_SESJE = 5;
const DNI_PRZECHOWYWANIA_METRYK = 90;

function doZakresu(wartosc, max) {
  const n = Number(wartosc);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.round(n), max);
}

/**
 * Zapisuje jedna sesje. Zwraca true, gdy wiersz trafil do bazy.
 * Sesje krotsze niz dwie sekundy pomijamy - to zwykle przeladowanie strony
 * albo bot, a nie wizyta mieszkanca.
 */
// Wersja 2 = odslony liczone dopiero wtedy, gdy reklama naprawde pojawi sie
// na ekranie, raz na sesje na reklamodawce. Patrz komentarz przy migracji.
const WERSJA_LICZNIKA = 2;
const MAX_REKLAM_NA_SESJE = 20;
const MAX_DL_NAZWY_REKLAMY = 80;

/**
 * Reklamy zobaczone w jednej sesji, oczyszczone i bez powtorek.
 *
 * Czysta funkcja, bez bazy - zeby dalo sie ja sprawdzic testem, ktory NIE
 * zapisuje niczego. To nie jest kosmetyka: test metryk uruchamia sie przy
 * kazdym starcie serwera, a modul bazy jest wtedy juz polaczony z PRAWDZIWA
 * baza. Test siegajacy do zapisu dopisywalby sztuczne sesje do produkcyjnych
 * metryk przy kazdym wdrozeniu - czyli falszowalby dokladnie te liczby,
 * ktore maja byc wiarygodne wobec reklamodawcow.
 *
 * Appka przysyla kazda reklame najwyzej raz, ale nie ufamy temu na slowo:
 * trasa /api/metryki jest otwarta (musi byc, bo wysylka idzie przy
 * zamykaniu karty), wiec przyjac moze cokolwiek.
 */
function przygotujReklamy(surowe) {
  const lista = Array.isArray(surowe) ? surowe : [];
  const widziane = [];
  const juz = new Set();

  for (const r of lista.slice(0, MAX_REKLAM_NA_SESJE)) {
    const nazwa = String((r && r.nazwa) || '').replace(/\s+/g, ' ').trim()
      .slice(0, MAX_DL_NAZWY_REKLAMY);
    if (!nazwa) continue;
    const idReklamy = Number.isFinite(Number(r.id)) ? Math.trunc(Number(r.id)) : null;
    const klucz = idReklamy === null ? `n:${nazwa.toLowerCase()}` : `i:${idReklamy}`;
    if (juz.has(klucz)) continue;
    juz.add(klucz);
    widziane.push({ id: idReklamy, nazwa });
  }

  return widziane;
}

function zapiszSesje(dane = {}) {
  const czas = doZakresu(dane.czas_s, MAX_CZAS_SESJI_S);
  if (czas < MIN_CZAS_SESJI_S) return false;

  const widziane = przygotujReklamy(dane.reklamy);

  db.prepare(`
    INSERT INTO metryki_sesji (czas_s, wyszukiwan, pustych, odslon_reklam, przelaczen, wersja_licznika)
    VALUES (@czas_s, @wyszukiwan, @pustych, @odslon_reklam, @przelaczen, @wersja)
  `).run({
    czas_s: czas,
    wyszukiwan: doZakresu(dane.wyszukiwan, MAX_LICZNIK),
    pustych: doZakresu(dane.pustych, MAX_LICZNIK),
    // Liczba REKLAMODAWCOW zobaczonych w tej sesji, a nie wstawien pola.
    odslon_reklam: widziane.length,
    przelaczen: doZakresu(dane.przelaczen, MAX_LICZNIK),
    wersja: WERSJA_LICZNIKA,
  });

  const wstawReklame = db.prepare('INSERT INTO metryki_reklam (reklama_id, nazwa) VALUES (?, ?)');
  for (const r of widziane) wstawReklame.run(r.id, r.nazwa);

  const frazy = Array.isArray(dane.puste_frazy) ? dane.puste_frazy : [];
  const wstaw = db.prepare('INSERT INTO metryki_pytania (fraza) VALUES (?)');
  for (const surowa of frazy.slice(0, MAX_FRAZ_NA_SESJE)) {
    const fraza = String(surowa || '').replace(/\s+/g, ' ').trim().slice(0, MAX_DL_FRAZY);
    if (fraza.length >= 2) wstaw.run(fraza);
  }
  return true;
}

/**
 * Zestawienie dla panelu. Sedno to dwie kolumny obok siebie: sesje
 * Z wyszukiwaniem i BEZ niego. Jesli te pierwsze sa krotsze i maja mniej
 * odslon reklam, obawa o reklamodawcow byla sluszna. Jesli nie - nie byla.
 */
function getMetryki(days = 14) {
  const od = new Date(Date.now() - days * 86400000).toISOString();

  // WSZYSTKO liczymy wylacznie z sesji w wersji 2 licznika. Sesje starsze
  // mialy odslony liczone zupelnie inaczej (wstawienia pola zamiast
  // obejrzen), wiec zsumowanie jednych z drugimi dawaloby liczbe, ktorej
  // nie da sie obronic przed klientem. Lepiej zaczac od zera i wiedziec,
  // co sie liczy, niz miec duza liczbe nieznanego pochodzenia.
  const wersja = `wersja_licznika >= ${WERSJA_LICZNIKA}`;

  const grupa = (warunek) => db.prepare(`
    SELECT COUNT(*) AS sesji,
           COALESCE(AVG(czas_s), 0) AS sredniCzas,
           COALESCE(AVG(odslon_reklam), 0) AS srednieOdslony,
           COALESCE(SUM(odslon_reklam), 0) AS odslonyRazem,
           COALESCE(AVG(przelaczen), 0) AS sredniePrzelaczenia
    FROM metryki_sesji WHERE created_at >= ? AND ${wersja} AND ${warunek}
  `).get(od);

  const zWyszukiwaniem = grupa('wyszukiwan > 0');
  const bezWyszukiwania = grupa('wyszukiwan = 0');

  const ogolem = db.prepare(`
    SELECT COUNT(*) AS sesji,
           COALESCE(SUM(wyszukiwan), 0) AS wyszukiwanRazem,
           COALESCE(SUM(pustych), 0) AS pustychRazem,
           COALESCE(SUM(odslon_reklam), 0) AS odslonyRazem
    FROM metryki_sesji WHERE created_at >= ? AND ${wersja}
  `).get(od);

  // Sedno dla reklamodawcy: ile OSOB mialo te reklame na ekranie.
  const reklamy = db.prepare(`
    SELECT COALESCE(reklama_id, -1) AS id,
           nazwa,
           COUNT(*) AS osob,
           MIN(created_at) AS odKiedy
    FROM metryki_reklam
    WHERE created_at >= ?
    GROUP BY COALESCE(reklama_id, LOWER(nazwa))
    ORDER BY osob DESC, nazwa ASC
  `).all(od);

  // Ile sesji sprzed zmiany licznika pomijamy - zeby panel mogl to napisac
  // wprost, zamiast po cichu pokazywac mniejsze liczby niz wczoraj.
  const stare = db.prepare(
    `SELECT COUNT(*) AS sesji FROM metryki_sesji WHERE created_at >= ? AND wersja_licznika < ${WERSJA_LICZNIKA}`,
  ).get(od);

  const pierwsza = db.prepare(
    `SELECT created_at FROM metryki_sesji WHERE ${wersja} ORDER BY id ASC LIMIT 1`,
  ).get();

  const pustePytania = db.prepare(`
    SELECT fraza, COUNT(*) AS ile FROM metryki_pytania
    WHERE created_at >= ? GROUP BY LOWER(fraza) ORDER BY ile DESC, fraza ASC LIMIT 12
  `).all(od);

  return {
    dni: days,
    zbieraOd: pierwsza ? pierwsza.created_at : null,
    ogolem,
    zWyszukiwaniem,
    bezWyszukiwania,
    pustePytania,
    reklamy,
    pominietychStarych: stare ? stare.sesji : 0,
  };
}

// Metryki nie sa archiwum - po trzech miesiacach nie powiedza juz nic,
// czego nie widac w swiezszych danych, a baza na Renderze jest mala.
function przytnijMetryki() {
  const granica = new Date(Date.now() - DNI_PRZECHOWYWANIA_METRYK * 86400000).toISOString();
  const a = db.prepare('DELETE FROM metryki_sesji WHERE created_at < ?').run(granica);
  const b = db.prepare('DELETE FROM metryki_pytania WHERE created_at < ?').run(granica);
  const c = db.prepare('DELETE FROM metryki_reklam WHERE created_at < ?').run(granica);
  const razem = a.changes + b.changes + c.changes;
  if (razem) console.log(`[db] usunieto ${razem} metryk starszych niz ${DNI_PRZECHOWYWANIA_METRYK} dni`);
  return razem;
}

try {
  przytnijMetryki();
} catch (err) {
  console.error('[db] blad przycinania metryk:', err.message);
}

function getPushStats(days = 7) {
  const start = getPushLogStart();
  const oknoOd = new Date(Date.now() - days * 86400000);
  // Jesli dziennik jest mlodszy niz zadane okno, liczymy od jego zalozenia
  // - inaczej porownywalibysmy wpisy z 7 dni z wysylkami z jednego dnia.
  const dziennikMlodszy = start && new Date(start).getTime() > oknoOd.getTime();
  const od = dziennikMlodszy ? start : oknoOd.toISOString();
  const w = db.prepare(`
    SELECT COALESCE(SUM(dostarczono), 0) AS dostarczono,
           COALESCE(SUM(bledow), 0) AS bledow,
           COALESCE(SUM(pominieto_stare), 0) AS pominietoStare,
           COUNT(*) AS cykli
    FROM push_log WHERE kind = 'wysylka' AND created_at >= ?
  `).get(od);
  const noweWpisy = db.prepare('SELECT COUNT(*) AS n FROM utrudnienia WHERE fetched_at >= ?').get(od).n;
  const ostatnia = db.prepare(
    "SELECT created_at FROM push_log WHERE kind = 'wysylka' AND dostarczono > 0 ORDER BY id DESC LIMIT 1"
  ).get();
  return {
    dni: days,
    zbieraOd: start,
    pelneDane: !dziennikMlodszy,
    noweWpisy,
    dostarczono: w.dostarczono,
    bledow: w.bledow,
    pominietoStare: w.pominietoStare,
    cykliWysylki: w.cykli,
    ostatniaUdanaWysylka: ostatnia ? ostatnia.created_at : null,
    subskrybenci: db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions').get().n,
  };
}

// Ukrywa wpisy w appce (active = 0), nie kasujac ich z bazy. Uzywane, gdy
// scraper rozpozna, ze wczesniej zapisany wpis nie powinien byl tam trafic.
// Zwraca liczbe wpisow, ktore faktycznie zmienily stan.
function deactivateByUrls(urls) {
  if (!urls || !urls.length) return 0;
  const placeholders = urls.map(() => '?').join(',');
  const wynik = db
    .prepare(`UPDATE utrudnienia SET active = 0 WHERE active = 1 AND source_url IN (${placeholders})`)
    .run(...urls);
  return wynik.changes;
}

function getSetting(klucz) {
  const r = db.prepare('SELECT wartosc FROM app_state WHERE klucz = ?').get(klucz);
  return r ? r.wartosc : null;
}

function setSetting(klucz, wartosc) {
  db.prepare(`
    INSERT INTO app_state (klucz, wartosc, updated_at)
    VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(klucz) DO UPDATE SET wartosc = excluded.wartosc, updated_at = excluded.updated_at
  `).run(klucz, wartosc == null ? null : String(wartosc));
}

function getLatestFact() {
  return db.prepare('SELECT * FROM daily_fact ORDER BY fact_date DESC LIMIT 1').get();
}

function saveSubscription(endpoint, subscriptionJson, categories) {
  db.prepare(`
    INSERT INTO push_subscriptions (endpoint, subscription_json, categories)
    VALUES (@endpoint, @subscription_json, @categories)
    ON CONFLICT(endpoint) DO UPDATE SET
      subscription_json = excluded.subscription_json,
      categories = excluded.categories
  `).run({ endpoint, subscription_json: subscriptionJson, categories });
}

function deleteSubscription(endpoint) {
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
}

function getAllSubscriptions() {
  return db.prepare('SELECT * FROM push_subscriptions').all();
}

// Podsumowanie subskrypcji powiadomien - do diagnozy w panelu admina.
// NIE zwraca pelnych adresow endpointow (to identyfikatory konkretnych
// urzadzen) - tylko dostawce, kategorie i date zapisu. To wystarczy, by
// stwierdzic, czy ktos sie w ogole zapisal i na jakie kategorie.
function listSubscriptionSummary() {
  const rows = db.prepare('SELECT endpoint, categories, created_at FROM push_subscriptions ORDER BY created_at DESC').all();
  return rows.map((r) => {
    let dostawca = 'nieznany';
    try {
      const host = new URL(r.endpoint).hostname;
      if (host.includes('fcm.googleapis') || host.includes('android')) dostawca = 'Android / Chrome';
      else if (host.includes('push.apple')) dostawca = 'Apple (iPhone)';
      else if (host.includes('mozilla')) dostawca = 'Firefox';
      else if (host.includes('windows') || host.includes('notify')) dostawca = 'Windows / Edge';
      else dostawca = host;
    } catch { /* zostawiamy "nieznany" */ }
    return {
      dostawca,
      // Pusta lista kategorii oznacza "wszystkie" - tak to traktuje
      // notifySubscribers w push.js. Wczesniej panel opisywal to jako
      // "nie dostanie nic", czyli dokladnie odwrotnie niz dziala kod.
      kategorie: r.categories || '(wszystkie)',
      zapisano: r.created_at,
      // kilka ostatnich znakow, zeby rozroznic urzadzenia bez ujawniania adresu
      id: r.endpoint.slice(-8),
    };
  });
}

// Reklamy widoczne w appce TERAZ. Okres emisji jest domkniety z obu stron:
// starts_at = od kiedy (puste znaczy "od zaraz"), expires_at = do kiedy
// (puste znaczy "bezterminowo"). Obie daty sa wlaczne - reklama z okresem
// 1-31 stycznia wyswietla sie takze pierwszego i trzydziestego pierwszego.
function listActiveAds() {
  return db.prepare(`
    SELECT * FROM local_ads
    WHERE active = 1
      AND (starts_at IS NULL OR starts_at = '' OR date(starts_at) <= date('now'))
      AND (expires_at IS NULL OR expires_at = '' OR date(expires_at) >= date('now'))
    ORDER BY id DESC
  `).all();
}

function createAd({ business_name, tagline, link_url, starts_at, expires_at }) {
  const info = db.prepare(`
    INSERT INTO local_ads (business_name, tagline, link_url, starts_at, expires_at)
    VALUES (@business_name, @tagline, @link_url, @starts_at, @expires_at)
  `).run({
    business_name,
    tagline,
    link_url,
    starts_at: starts_at || null,
    expires_at: expires_at || null,
  });
  return info.lastInsertRowid;
}

function updateAd(id, { business_name, tagline, link_url, starts_at, expires_at }) {
  db.prepare(`
    UPDATE local_ads
    SET business_name = @business_name,
        tagline = @tagline,
        link_url = @link_url,
        starts_at = @starts_at,
        expires_at = @expires_at,
        reminder_sent = 0
    WHERE id = @id
  `).run({
    id,
    business_name,
    tagline,
    link_url,
    starts_at: starts_at || null,
    expires_at: expires_at || null,
  });
}

function deactivateAd(id) {
  db.prepare('UPDATE local_ads SET active = 0 WHERE id = ?').run(id);
}

function listAllAds() {
  return db.prepare('SELECT * FROM local_ads ORDER BY id DESC').all();
}

function deactivateExpiredAds() {
  const expired = db.prepare(`
    SELECT * FROM local_ads
    WHERE active = 1 AND expires_at IS NOT NULL AND expires_at != '' AND date(expires_at) < date('now')
  `).all();
  if (expired.length) {
    const ids = expired.map((a) => a.id);
    const placeholders = ids.map(() => '?').join(',');
    db.prepare(`UPDATE local_ads SET active = 0 WHERE id IN (${placeholders})`).run(...ids);
  }
  return expired;
}

function getAdsNeedingReminder() {
  return db.prepare(`
    SELECT * FROM local_ads
    WHERE active = 1
      AND expires_at IS NOT NULL AND expires_at != ''
      AND reminder_sent = 0
      AND date(expires_at) <= date('now', '+7 days')
      AND date(expires_at) >= date('now')
  `).all();
}

function markReminderSent(id) {
  db.prepare('UPDATE local_ads SET reminder_sent = 1 WHERE id = ?').run(id);
}

// Zapisuje cotygodniowy raport zdrowia appki, zeby mozna go bylo pozniej
// przejrzec w panelu admina zamiast grzebac w logach Render. Trzyma tylko
// ostatnie 50 raportow (ok. rok przy cotygodniowym cyklu) - usuwa starsze
// przy kazdym zapisie, zeby tabela nie rosla bez konca.
function saveHealthReport(report, hasProblem) {
  db.prepare(`
    INSERT INTO health_reports (report, has_problem) VALUES (?, ?)
  `).run(report, hasProblem ? 1 : 0);
  db.prepare(`
    DELETE FROM health_reports WHERE id NOT IN (
      SELECT id FROM health_reports ORDER BY created_at DESC LIMIT 50
    )
  `).run();
}

function listHealthReports(limit = 50) {
  return db.prepare('SELECT * FROM health_reports ORDER BY created_at DESC LIMIT ?').all(limit);
}

module.exports = {
  db,
  upsertMany,
  listUtrudnienia,
  getDescriptionsByUrls,
  policzWKategoriach,
  zapiszSesje,
  przygotujReklamy,
  MAX_REKLAM_NA_SESJE,
  MAX_DL_NAZWY_REKLAMY,
  WERSJA_LICZNIKA,
  getMetryki,
  przytnijMetryki,
  dezaktywujDuplikatyTresci,
  wskazDuplikaty,
  MIN_OPIS_DUPLIKATU,
  REGULA_TRESCI_ZRODLA,
  MAX_UKRYTYCH_REGULA_TRESCI,
  getSetting,
  setSetting,
  deactivateByUrls,
  getDailyFact,
  deleteDailyFact,
  saveDailyFact,
  getRecentFacts,
  getLatestFact,
  recordSourceResult,
  markSourceAlerted,
  recordPushAttempt,
  checkPushSilence,
  getPushStats,
  ensurePushLogStarted,
  listSourceHealth,
  listSubscriptionSummary,
  saveSubscription,
  deleteSubscription,
  getAllSubscriptions,
  listActiveAds,
  createAd,
  updateAd,
  deactivateAd,
  listAllAds,
  deactivateExpiredAds,
  getAdsNeedingReminder,
  markReminderSent,
  saveHealthReport,
  listHealthReports,
};
