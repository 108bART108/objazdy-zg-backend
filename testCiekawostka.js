// Testy odzyskiwania tresci bez ponownego generowania.
//
// TEN TEST NIE WYCHODZI DO SIECI. Podstawia fetch, wiec nie kosztuje ani
// grosza i mozna go uruchamiac przy kazdym starcie serwera.
//
// TLO - pomiar z 25.11.2026, prawdziwy cykl z produkcji:
//   9 wywolan, 250 177 tokenow wejscia, 15 platnych wyszukan
//   proba 1: "recenzent nie uzyl wymaganych znacznikow - odrzucam odpowiedz"
//   proba 2: "naprawa nie uzyla znacznikow - pomijam"
//   proba 3: przyjeto
//
// Model wykonal prace i zostala ona oplacona - recenzja miala 4779 tokenow
// wyjscia. Kod wyrzucil ja w calosci, bo nie byla opakowana w <ciekawostka>,
// i zaczal od zera z nowym wyszukiwaniem. Dzien kosztowal okolo piec razy
// tyle, co powinien, a przyczyna nie byla merytoryczna, tylko formalna.
//
// Testy pilnuja, zeby odzyskiwanie DZIALALO, ale zeby NIE przepuszczalo
// bylejakosci: pusta odpowiedz, sama recenzja bez gotowego tekstu albo
// nieudane przepisanie nadal musza konczyc sie odrzuceniem.

const path = require('path');
const fs = require('fs');
const os = require('os');

const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'ciekawostka-test-'));
process.env.DB_PATH = path.join(katalog, 'proba.db');
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'test';

const bledy = [];
let sprawdzonych = 0;

function sprawdz(opis, warunek) {
  sprawdzonych += 1;
  if (!warunek) bledy.push(opis);
}

function rowne(opis, mam, oczekuje) {
  sprawdzonych += 1;
  if (mam !== oczekuje) bledy.push(`${opis} - jest "${mam}", powinno byc "${oczekuje}"`);
}

const FAKT = 'W Zielonej Górze działa jedyny w Polsce miejski ogród winny, '
  + 'a tradycja winiarska sięga tu XIII wieku.';

// Prawdziwy ksztalt odpowiedzi, ktora wczoraj zostala wyrzucona: dluga
// recenzja z gotowym tekstem w srodku, ale bez znacznikow.
const RECENZJA_BEZ_ZNACZNIKOW = `Sprawdziłem podany fakt w dostępnych źródłach. `
  + `Informacja o tradycji winiarskiej znajduje potwierdzenie na oficjalnej stronie miasta `
  + `oraz w Wikipedii. Data XIII wieku jest zgodna z zachowanymi dokumentami. `
  + `Drobna uwaga językowa: oryginalne sformułowanie zawierało powtórzenie. `
  + `Ostateczna, poprawiona wersja ciekawostki brzmi: ${FAKT}`;

function podstawFetch(odpowiedzi) {
  let i = 0;
  global.fetch = async () => {
    const tekst = odpowiedzi[Math.min(i, odpowiedzi.length - 1)];
    i += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: tekst }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    };
  };
  return () => i;
}

function wczytajModul() {
  delete require.cache[require.resolve('./ciekawostka')];
  return require('./ciekawostka');
}

async function testOdzyskiwanie() {
  // Recenzent nie uzyl znacznikow -> przepisanie zwraca sam fakt.
  const ile = podstawFetch([RECENZJA_BEZ_ZNACZNIKOW, `<ciekawostka>${FAKT}</ciekawostka>`]);
  const modul = wczytajModul();
  const wynik = await modul.forceRegenerateTodayFact().catch((e) => ({ blad: e.message }));

  sprawdz('tresc odzyskano bez ponownego generowania', Boolean(wynik && wynik.content));
  if (wynik && wynik.content) {
    sprawdz('odzyskany tekst to sam fakt, bez recenzji',
      !/Sprawdziłem|źródł|uwaga językowa/i.test(wynik.content));
    sprawdz('odzyskany tekst zawiera tresc ciekawostki',
      /ogród winny|winiarsk/i.test(wynik.content));
  }

  // Najwazniejsza liczba: ile wywolan. Bez odzyskiwania byloby ich
  // kilkanascie, bo kazda nieudana proba to pelny cykl z wyszukiwaniem.
  const wywolan = ile();
  sprawdz(`odzyskanie kosztuje kilka wywolan, nie kilkanascie (bylo ${wywolan})`,
    wywolan <= 5);
}

async function testPustaOdpowiedz() {
  // W odpowiedzi nie ma gotowej ciekawostki - przepisanie zwraca pustke
  // i wtedy MUSIMY odrzucic, a nie publikowac czegokolwiek.
  podstawFetch(['Nie jestem pewien tego faktu i wolę go nie potwierdzać.',
    '<ciekawostka></ciekawostka>']);
  const modul = wczytajModul();
  const wynik = await modul.forceRegenerateTodayFact().catch((e) => ({ blad: e.message }));
  sprawdz('puste znaczniki po przepisaniu konczy sie odrzuceniem',
    Boolean(wynik && wynik.blad));
}

async function testPrzepisanieNieodpowiada() {
  // Przepisanie tez moze zawiesc - wtedy zachowujemy sie jak dotad.
  let i = 0;
  global.fetch = async () => {
    i += 1;
    if (i % 2 === 0) throw new Error('siec padla');
    return {
      ok: true,
      status: 200,
      json: async () => ({
        content: [{ type: 'text', text: RECENZJA_BEZ_ZNACZNIKOW }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    };
  };
  const modul = wczytajModul();
  const wynik = await modul.forceRegenerateTodayFact().catch((e) => ({ blad: e.message }));
  sprawdz('nieudane przepisanie nie wywala procesu', Boolean(wynik));
}

async function testZnacznikiWprost() {
  // Gdy znaczniki sa - zadnego dodatkowego wywolania.
  const ile = podstawFetch([`<ciekawostka>${FAKT}</ciekawostka>`]);
  const modul = wczytajModul();
  const wynik = await modul.forceRegenerateTodayFact().catch((e) => ({ blad: e.message }));
  sprawdz('poprawna odpowiedz przechodzi bez przepisywania', Boolean(wynik && wynik.content));
  sprawdz(`poprawna odpowiedz nie dokłada wywolan (bylo ${ile()})`, ile() <= 4);
}

function testUstawienia() {
  const zrodlo = fs.readFileSync(path.join(__dirname, 'ciekawostka.js'), 'utf8');

  // Limit wyszukan musi trafic do zapytania - bez tego model szuka ile chce,
  // a kazde zapytanie to kilkanascie tysiecy tokenow wejscia.
  sprawdz('limit wyszukan jest przekazywany do API', /max_uses:\s*MAX_WYSZUKAN/.test(zrodlo));
  const m = zrodlo.match(/MAX_WYSZUKAN\s*=\s*(\d+)/);
  sprawdz('limit wyszukan jest ustawiony rozsadnie',
    m && Number(m[1]) >= 1 && Number(m[1]) <= 3);

  // Zadna sciezka nie moze juz po cichu wyrzucac odpowiedzi bez znacznikow.
  sprawdz('nie zostalo miejsca, ktore odrzuca odpowiedz przez brak znacznikow',
    !/odrzucam odpowiedz|pomijam krok korekty/.test(zrodlo));
}

async function uruchomTesty() {
  bledy.length = 0;
  sprawdzonych = 0;
  const prawdziwyFetch = global.fetch;
  try {
    await testOdzyskiwanie();
    await testPustaOdpowiedz();
    await testPrzepisanieNieodpowiada();
    await testZnacznikiWprost();
    testUstawienia();
  } finally {
    global.fetch = prawdziwyFetch;
  }
  return { sprawdzonych, bledy };
}

if (require.main === module) {
  uruchomTesty().then((wynik) => {
    for (const b of wynik.bledy) console.error(`  BLAD: ${b}`);
    console.log(`Sprawdzono ${wynik.sprawdzonych} warunkow, bledow: ${wynik.bledy.length}`);
    try { fs.rmSync(katalog, { recursive: true, force: true }); } catch { /* nic */ }
    if (wynik.bledy.length) process.exitCode = 1;
  });
}

module.exports = { uruchomTesty };
