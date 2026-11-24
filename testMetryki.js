// Testy odsiewania odslon reklam.
//
// TEN TEST NICZEGO NIE ZAPISUJE i jest to warunek, a nie wygoda. Kontrola
// startowa uruchamia go przy kazdym starcie serwera, a modul bazy jest
// wtedy juz polaczony z PRAWDZIWA baza - test siegajacy do zapisu
// dopisywalby sztuczne sesje do produkcyjnych metryk przy kazdym
// wdrozeniu. Falszowalby wiec dokladnie te liczby, ktore maja byc
// wiarygodne wobec reklamodawcow. Dlatego sprawdzamy czysta funkcje
// przygotujReklamy, a nie droge do bazy.
//
// TLO. Do 24.11.2026 licznik zliczal WSTAWIENIA pola reklamowego do strony,
// a nie obejrzenia reklamy. Appka rysuje liste od nowa przy kazdym
// przelaczeniu zakladki i przy kazdym wyszukiwaniu, a w kazdym rysowaniu
// wstawia pole co drugi wpis - wiec jedna osoba potrafila "wygenerowac"
// trzydziesci odslon, nie przewijajac ekranu. Panel pokazal 1706 odslon
// przy 49 sesjach, czyli okolo dziesieciokrotnie za duzo.
//
// Ta liczba idzie do klienta na fakturze, wiec testy pilnuja przede
// wszystkim tego, zeby NIE DALA SIE ZAWYZYC - ani przez appke, ktora
// przysle to samo dwa razy, ani przez kogos, kto wysle zmyslone dane
// wprost na nasz adres (trasa /api/metryki musi byc otwarta, bo wysylka
// idzie przy zamykaniu karty).

const {
  przygotujReklamy, MAX_REKLAM_NA_SESJE, MAX_DL_NAZWY_REKLAMY, WERSJA_LICZNIKA,
} = require('./db');

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

const r = (id, nazwa) => ({ id, nazwa });

// --- 1. zwykly przypadek ----------------------------------------------------

function testZwykly() {
  const w = przygotujReklamy([r(1, 'Piekarnia Kowalski'), r(2, 'Kwiaciarnia Róża')]);
  rowne('dwie rozne reklamy przechodza', w.length, 2);
  rowne('nazwa zachowana', w[0].nazwa, 'Piekarnia Kowalski');
  rowne('id zachowane jako liczba', w[0].id, 1);
}

// --- 2. czego NIE da sie zawyzyc -------------------------------------------

function testNieDaSieZawyzyc() {
  rowne('ta sama reklama przyslana trzy razy liczy sie raz',
    przygotujReklamy([r(7, 'Kwiaciarnia'), r(7, 'Kwiaciarnia'), r(7, 'Kwiaciarnia')]).length, 1);

  rowne('ten sam id pod dwiema nazwami liczy sie raz',
    przygotujReklamy([r(7, 'Kwiaciarnia Róża'), r(7, 'Kwiaciarnia Roza')]).length, 1);

  rowne('bez id powtorka po nazwie tez jest odsiewana',
    przygotujReklamy([{ nazwa: 'Bar Pod Lipą' }, { nazwa: 'bar pod lipą' }]).length, 1);

  rowne('ta sama nazwa z roznymi odstepami to wciaz jedna reklama',
    przygotujReklamy([{ nazwa: 'Bar  Pod   Lipą' }, { nazwa: 'Bar Pod Lipą' }]).length, 1);

  // Ktos moglby wyslac wprost na nasz adres tysiac reklam w jednej sesji.
  const zaduzo = [];
  for (let i = 0; i < 500; i += 1) zaduzo.push(r(1000 + i, `Firma ${i}`));
  rowne('liczba reklam w jednej sesji jest ograniczona',
    przygotujReklamy(zaduzo).length, MAX_REKLAM_NA_SESJE);

  // Dwie RÓŻNE firmy o tej samej nazwie, ale innym id - obie sa prawdziwe.
  rowne('rozne id to rozne reklamy, nawet przy tej samej nazwie',
    przygotujReklamy([r(1, 'Sklep'), r(2, 'Sklep')]).length, 2);
}

// --- 3. smieci w danych -----------------------------------------------------

function testSmieci() {
  rowne('brak danych daje pusta liste', przygotujReklamy(undefined).length, 0);
  rowne('null daje pusta liste', przygotujReklamy(null).length, 0);
  rowne('tekst zamiast tablicy daje pusta liste', przygotujReklamy('nie-tablica').length, 0);
  rowne('pusta tablica daje pusta liste', przygotujReklamy([]).length, 0);

  rowne('reklama bez nazwy odpada', przygotujReklamy([{ id: 9 }]).length, 0);
  rowne('nazwa z samych spacji odpada', przygotujReklamy([{ id: 9, nazwa: '   ' }]).length, 0);
  rowne('null w tablicy nie wywala funkcji', przygotujReklamy([null, r(1, 'Sklep')]).length, 1);

  const zDziwnymId = przygotujReklamy([{ id: 'nie-liczba', nazwa: 'Firma Dziwna' }]);
  rowne('niepoprawne id nie odrzuca reklamy', zDziwnymId.length, 1);
  rowne('niepoprawne id zapisujemy jako brak', zDziwnymId[0].id, null);

  const zUlamkiem = przygotujReklamy([{ id: 3.9, nazwa: 'Firma' }]);
  rowne('id ulamkowe jest obcinane do calkowitego', zUlamkiem[0].id, 3);

  const dluga = przygotujReklamy([{ id: 42, nazwa: 'X'.repeat(500) }]);
  rowne('bardzo dluga nazwa jest przycinana', dluga[0].nazwa.length, MAX_DL_NAZWY_REKLAMY);
}

// --- 4. wersja licznika -----------------------------------------------------

function testWersja() {
  // Stare sesje liczyly cos innego i nie wolno ich zsumowac z nowymi.
  sprawdz('wersja licznika jest wyzsza niz pierwotna', WERSJA_LICZNIKA >= 2);
  sprawdz('limit reklam na sesje jest rozsadny',
    MAX_REKLAM_NA_SESJE >= 5 && MAX_REKLAM_NA_SESJE <= 50);
}

function uruchomTesty() {
  bledy.length = 0;
  sprawdzonych = 0;
  testZwykly();
  testNieDaSieZawyzyc();
  testSmieci();
  testWersja();
  return { sprawdzonych, bledy };
}

if (require.main === module) {
  const wynik = uruchomTesty();
  for (const b of wynik.bledy) console.error(`  BLAD: ${b}`);
  console.log(`Sprawdzono ${wynik.sprawdzonych} warunkow, bledow: ${wynik.bledy.length}`);
  if (wynik.bledy.length) process.exitCode = 1;
}

module.exports = { uruchomTesty };
