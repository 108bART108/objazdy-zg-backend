// Testy recznego zdejmowania wpisow z appki.
//
// TEN TEST NICZEGO NIE ZAPISUJE DO PRAWDZIWEJ BAZY - zaklada wlasna, pusta,
// w katalogu tymczasowym. Uruchamia sie recznie (node testUkrywanie.js),
// bo siega do bazy, a kontrola startowa chodzi przy kazdym starcie serwera
// na produkcji.
//
// PO CO TO POWSTALO. Do 25.11.2026 nie bylo jak zdjac wpisu inaczej niz
// przez SQL w konsoli serwera. Gdy do zakladki "drogi" wszedl 400-slowny
// artykul o remoncie galerii BWA, trzeba bylo logowac sie do Shella
// i pisac UPDATE recznie.
//
// Dwie rzeczy sa tu najwazniejsze i obie maja wlasne testy:
//   1. ukrycie MUSI przetrwac ponowne zapisanie wpisu przez scraper -
//      zwykle active = 0 nie wystarcza, bo zapis ustawia active = 1
//      przy kazdym cyklu i wpis wracalby po dziesieciu minutach;
//   2. trasy admina MUSZA sprawdzac klucz - raz w tym projekcie
//      wystawilem endpoint bez sprawdzania i wolalbym nie powtorzyc.

const path = require('path');
const fs = require('fs');
const os = require('os');

const katalog = fs.mkdtempSync(path.join(os.tmpdir(), 'ukrywanie-test-'));
process.env.DB_PATH = path.join(katalog, 'proba.db');

const {
  upsertMany, listUtrudnienia, listDlaAdmina, ukryjWpis, przywrocWpis,
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

const BWA = {
  source_url: 'https://www.zielona-gora.pl/bwa-modernizacja',
  source_name: 'UM Zielona Gora',
  category: 'drogi',
  title: 'BWA i dawna szkola muzyczna do modernizacji',
  street: null,
  description: 'Nowa sala projekcyjna, winda i zagospodarowany ogrod - tak zmieni sie willa przy BWA.',
  published_at: new Date().toISOString(),
};

const DOBRY = {
  source_url: 'https://www.zielona-gora.pl/remont-lipowej',
  source_name: 'UM Zielona Gora',
  category: 'drogi',
  title: 'Remont ul. Lipowej',
  street: 'ul. Lipowa',
  description: 'Od poniedzialku rozpoczyna sie remont ulicy Lipowej. Przewidziano objazdy.',
  published_at: new Date().toISOString(),
};

function idWpisu(tytul) {
  const w = listDlaAdmina({ limit: 500 }).find((x) => x.title === tytul);
  return w ? w.id : null;
}

function testUkrywanie() {
  upsertMany([BWA, DOBRY]);

  rowne('na poczatku appka pokazuje oba wpisy',
    listUtrudnienia({ category: 'drogi' }).length, 2);

  const id = idWpisu(BWA.title);
  sprawdz('panel admina widzi wpis i podaje jego numer', Boolean(id));

  rowne('ukrycie udaje sie', ukryjWpis(id, 'to remont budynku, nie drogi'), true);

  const poUkryciu = listUtrudnienia({ category: 'drogi' });
  rowne('appka pokazuje juz tylko jeden wpis', poUkryciu.length, 1);
  rowne('zostal ten wlasciwy', poUkryciu[0].title, DOBRY.title);

  // Panel musi widziec WIECEJ niz appka - inaczej ukryty wpis znika takze
  // przed wlascicielem i nie da sie go przywrocic inaczej niz przez baze.
  const wPanelu = listDlaAdmina({ limit: 500 });
  rowne('panel admina nadal widzi oba wpisy', wPanelu.length, 2);
  const ukryty = wPanelu.find((x) => x.id === id);
  rowne('panel oznacza wpis jako ukryty', ukryty.ukryty_recznie, 1);
  rowne('panel pokazuje powod ukrycia', ukryty.ukryty_powod, 'to remont budynku, nie drogi');
  sprawdz('panel pokazuje date ukrycia', Boolean(ukryty.ukryty_kiedy));

  rowne('powtorne ukrycie nie udaje sie', ukryjWpis(id, 'drugi raz'), false);
}

function testPrzetrwaScraper() {
  // SEDNO calej zmiany. Scraper zapisuje wpisy co dziesiec minut i ustawia
  // przy tym active = 1. Gdybysmy ukrywali przez active = 0, wpis wrocilby
  // do appki w nastepnym cyklu - a wlasciciel bylby przekonany, ze go zdjal.
  upsertMany([BWA, DOBRY]);

  const poScrapowaniu = listUtrudnienia({ category: 'drogi' });
  rowne('ukryty wpis NIE wraca po ponownym zapisaniu przez scraper',
    poScrapowaniu.length, 1);
  sprawdz('po scrapowaniu nadal nie ma wpisu o BWA',
    !poScrapowaniu.some((w) => /BWA/.test(w.title)));

  // Dziesiec cykli pod rzad - tak jak przez pol doby na produkcji.
  for (let i = 0; i < 10; i += 1) upsertMany([BWA]);
  rowne('po dziesieciu cyklach wpis nadal jest ukryty',
    listUtrudnienia({ category: 'drogi' }).length, 1);
}

function testPrzywracanie() {
  const id = idWpisu(BWA.title);
  rowne('przywrocenie udaje sie', przywrocWpis(id), true);
  rowne('appka znowu pokazuje oba wpisy',
    listUtrudnienia({ category: 'drogi' }).length, 2);
  rowne('powtorne przywrocenie nie udaje sie', przywrocWpis(id), false);

  const wPanelu = listDlaAdmina({ limit: 500 }).find((x) => x.id === id);
  rowne('po przywroceniu znacznik ukrycia znika', wPanelu.ukryty_recznie, 0);
  rowne('po przywroceniu powod jest czyszczony', wPanelu.ukryty_powod, null);
}

function testSmieci() {
  rowne('nieistniejacy numer nie ukrywa niczego', ukryjWpis(999999, 'x'), false);
  rowne('nieistniejacy numer nie przywraca niczego', przywrocWpis(999999), false);
  rowne('tekst zamiast numeru nie wywala funkcji', ukryjWpis('abc', 'x'), false);

  const id = idWpisu(DOBRY.title);
  rowne('ukrycie bez podanego powodu dziala', ukryjWpis(id, ''), true);
  const w = listDlaAdmina({ limit: 500 }).find((x) => x.id === id);
  rowne('brak powodu zapisuje sie jako brak', w.ukryty_powod, null);
  przywrocWpis(id);

  const dlugi = 'X'.repeat(500);
  const id2 = idWpisu(DOBRY.title);
  ukryjWpis(id2, dlugi);
  const w2 = listDlaAdmina({ limit: 500 }).find((x) => x.id === id2);
  sprawdz(`bardzo dlugi powod jest przycinany (ma ${w2.ukryty_powod.length} zn.)`,
    w2.ukryty_powod.length <= 200);
  przywrocWpis(id2);
}

function testZabezpieczenieTras() {
  // Raz w tym projekcie wystawilem trase admina bez sprawdzania klucza.
  // Ten test czyta kod serwera i pilnuje, zeby kazda nowa trasa admina
  // miala checkAdmin tuz za deklaracja.
  const zrodlo = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');
  const linie = zrodlo.split('\n');
  const bezKlucza = [];

  linie.forEach((linia, i) => {
    if (!/app\.(get|post|put|patch|delete)\('\/api\/admin/.test(linia)) return;

    // Szukamy az do POCZATKU NASTEPNEJ TRASY, a nie przez stala liczbe
    // wierszy. Pierwsza wersja tego testu zagladala trzy linie w dol
    // i zglosila trase /api/admin/metryki jako niechroniona - a ona jest
    // chroniona, tylko przed checkAdmin stal czterolinijkowy komentarz.
    // Test ma wylapywac prawdziwa dziure, a nie pilnowac ukladu wierszy.
    const chroniona = linie.slice(i + 1, i + 25)
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .some((l, j, tab) => {
        const wczesniej = tab.slice(0, j).some((x) => /app\.(get|post|put|patch|delete)\(/.test(x));
        return !wczesniej && /checkAdmin\(req, res\)/.test(l);
      });

    if (!chroniona) bezKlucza.push(linia.trim().slice(0, 80));
  });

  rowne(`kazda trasa admina sprawdza klucz (bez klucza: ${bezKlucza.join(' | ')})`,
    bezKlucza.length, 0);

  const ileTras = (zrodlo.match(/app\.(get|post|put|patch|delete)\('\/api\/admin/g) || []).length;
  sprawdz(`trasy admina istnieja i sa sprawdzane (${ileTras})`, ileTras >= 10);
}

function uruchomTesty() {
  bledy.length = 0;
  sprawdzonych = 0;
  testUkrywanie();
  testPrzetrwaScraper();
  testPrzywracanie();
  testSmieci();
  testZabezpieczenieTras();
  return { sprawdzonych, bledy };
}

if (require.main === module) {
  const wynik = uruchomTesty();
  for (const b of wynik.bledy) console.error(`  BLAD: ${b}`);
  console.log(`Sprawdzono ${wynik.sprawdzonych} warunkow, bledow: ${wynik.bledy.length}`);
  try { fs.rmSync(katalog, { recursive: true, force: true }); } catch { /* nic */ }
  if (wynik.bledy.length) process.exitCode = 1;
}

module.exports = { uruchomTesty };
