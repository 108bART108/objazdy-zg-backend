// Test odsiewania tego samego komunikatu zapisanego dwa razy.
// Uruchomienie:  node testDuplikaty.js
//
// Powstal 22.11.2026, pierwszego dnia dzialania zrodla PZZD. Urzad wystawil
// to samo zamkniecie drogi 1189F w Karszynie jako DWIE osobne pozycje - raz
// "Zamkniecie drogi powiatowej 1189F w m. Karszyn", raz tym samym tekstem pod
// krzyczacym tytulem "ZAMKNIECIE DROGI POWIATOWEJ NR 1189F W M. KARSZYN
// 25.08.2026 r.-26.08.2026r.". Obie tresci mialy identyczne 566 znakow, ale
// rozne tytuly - a dotychczasowy klucz deduplikacji sklejal kategorie, tytul
// i opis, wiec para nie byla duplikatem. Czytelnik widzial jeden komunikat
// dwa razy pod rzad.
//
// Druga strona tego samego medalu jest wazniejsza: regula "identyczna tresc =
// duplikat" latwo wycisza rzeczy, ktorych wyciszac NIE WOLNO. Dlatego wiekszosc
// przypadkow ponizej sprawdza nie to, co zostalo ukryte, a to, co MUSI zostac.

const { wskazDuplikaty, MIN_OPIS_DUPLIKATU } = require('./db');

// Tekst dlugosci podobnej do prawdziwego zawiadomienia PZZD.
const DLUGA_TRESC = ('Powiatowy Zielonogórski Zarząd Dróg informuje, że w związku z zamknięciem '
  + 'drogi powiatowej nr 1189F w miejscowości Karszyn konieczne jest wprowadzenie objazdu '
  + 'dla ruchu kołowego w obu kierunkach drogą wojewódzką nr 278 oraz drogami gminnymi. ').repeat(2);

const INNA_DLUGA_TRESC = ('Zarząd Dróg Wojewódzkich informuje o rozpoczęciu przebudowy mostu '
  + 'w miejscowości Pomorsko wraz z wprowadzeniem tymczasowej organizacji ruchu na czas '
  + 'prowadzenia robót budowlanych na odcinku drogi wojewódzkiej. ').repeat(2);

// Kazdy przypadek: nazwa, wiersze (posortowane po id, tak jak z bazy),
// oczekiwana lista ukrytych id.
const PRZYPADKI = [
  {
    nazwa: 'PZZD: to samo zamkniecie pod dwoma tytulami (prawdziwy przypadek z 22.11.2026)',
    rows: [
      { id: 1, source_name: 'PZZD Gorzykowo', category: 'drogi', description: DLUGA_TRESC, title: 'ZAMKNIĘCIE DROGI POWIATOWEJ NR 1189F W M. KARSZYN 25.08.2026 r.-26.08.2026r.' },
      { id: 2, source_name: 'PZZD Gorzykowo', category: 'drogi', description: DLUGA_TRESC, title: 'Zamknięcie drogi powiatowej 1189F w m. Karszyn' },
    ],
    ukryte: [2],
  },
  {
    nazwa: 'ten sam tytul i opis, dwa source_url - stara regula musi dalej dzialac',
    rows: [
      { id: 1, source_name: 'ZWiK', category: 'wodociagi', description: 'Awaria na ul. Dąbrowskiego.', title: 'Awaria wody' },
      { id: 2, source_name: 'ZWiK', category: 'wodociagi', description: 'Awaria na ul. Dąbrowskiego.', title: 'Awaria wody' },
    ],
    ukryte: [2],
  },
  {
    nazwa: 'DWA ZRODLA o tym samym - to potwierdzenie informacji, nie duplikat',
    rows: [
      { id: 1, source_name: 'UM Zielona Gora', category: 'drogi', description: DLUGA_TRESC, title: 'Obwodnica zachodnia' },
      { id: 2, source_name: 'ZDW Zielona Gora', category: 'drogi', description: DLUGA_TRESC, title: 'Obwodnica zachodnia - prace' },
    ],
    ukryte: [],
  },
  {
    nazwa: 'krotkie opisy rowne tytulom - rozne komunikaty, wszystkie musza zostac',
    rows: [
      { id: 1, source_name: 'PZZD Gorzykowo', category: 'drogi', description: 'Tour De Pologne', title: 'Tour De Pologne' },
      { id: 2, source_name: 'PZZD Gorzykowo', category: 'drogi', description: 'Zamknięcie drogi powiatowej 1189F', title: 'Zamknięcie drogi powiatowej 1189F' },
      { id: 3, source_name: 'PZZD Gorzykowo', category: 'drogi', description: 'Zamknięcie drogi powiatowej 1140F', title: 'Zamknięcie drogi powiatowej 1140F' },
    ],
    ukryte: [],
  },
  {
    nazwa: 'KROTKI opis identyczny w dwoch wpisach - za malo, by uznac za duplikat',
    rows: [
      { id: 1, source_name: 'Enea', category: 'prad', description: 'Planowana przerwa w dostawie energii.', title: 'Wyłączenie prądu - Chynów' },
      { id: 2, source_name: 'Enea', category: 'prad', description: 'Planowana przerwa w dostawie energii.', title: 'Wyłączenie prądu - Jędrzychów' },
    ],
    ukryte: [],
  },
  {
    nazwa: 'ta sama tresc, ale inna kategoria - nie ruszamy',
    rows: [
      { id: 1, source_name: 'UM Zielona Gora', category: 'drogi', description: DLUGA_TRESC, title: 'Prace na Wrocławskiej' },
      { id: 2, source_name: 'UM Zielona Gora', category: 'wodociagi', description: DLUGA_TRESC, title: 'Prace na Wrocławskiej' },
    ],
    ukryte: [],
  },
  {
    nazwa: 'rozne dlugie tresci w jednym zrodle - nic nie jest duplikatem',
    rows: [
      { id: 1, source_name: 'ZDW Zielona Gora', category: 'drogi', description: DLUGA_TRESC, title: 'Karszyn' },
      { id: 2, source_name: 'ZDW Zielona Gora', category: 'drogi', description: INNA_DLUGA_TRESC, title: 'Pomorsko' },
    ],
    ukryte: [],
  },
  {
    nazwa: 'trzy kopie tego samego - zostaje pierwsza, ukrywamy dwie',
    rows: [
      { id: 5, source_name: 'PZZD Gorzykowo', category: 'drogi', description: DLUGA_TRESC, title: 'Karszyn A' },
      { id: 7, source_name: 'PZZD Gorzykowo', category: 'drogi', description: DLUGA_TRESC, title: 'Karszyn B' },
      { id: 9, source_name: 'PZZD Gorzykowo', category: 'drogi', description: DLUGA_TRESC, title: 'Karszyn C' },
    ],
    ukryte: [7, 9],
  },
  {
    nazwa: 'ta sama tresc z roznica w bialych znakach i kropce na koncu',
    rows: [
      { id: 1, source_name: 'PZZD Gorzykowo', category: 'drogi', description: `${DLUGA_TRESC}`, title: 'A' },
      { id: 2, source_name: 'PZZD Gorzykowo', category: 'drogi', description: `${DLUGA_TRESC.replace(/ /g, '  ')}.`, title: 'B' },
    ],
    ukryte: [2],
  },
  {
    nazwa: 'pusta lista wpisow',
    rows: [],
    ukryte: [],
  },
];

function uruchomTesty() {
  const bledy = [];

  for (const p of PRZYPADKI) {
    const wynik = wskazDuplikaty(p.rows);
    const ukryte = wynik.map((d) => d.id).sort((a, b) => a - b);
    const oczekiwane = [...p.ukryte].sort((a, b) => a - b);

    if (ukryte.join(',') !== oczekiwane.join(',')) {
      bledy.push(`${p.nazwa}: ukryto [${ukryte.join(', ')}], a powinno [${oczekiwane.join(', ')}]`);
    }
  }

  // Prog dlugosci jest sercem tej reguly: za nisko ustawiony zaczyna wyciszac
  // rozne komunikaty o podobnym, krotkim opisie.
  if (MIN_OPIS_DUPLIKATU < 150) {
    bledy.push(`prog MIN_OPIS_DUPLIKATU = ${MIN_OPIS_DUPLIKATU} jest za niski - `
      + 'krotkie, przypadkowo zbiezne opisy zaczna byc uznawane za duplikaty');
  }

  return { sprawdzonych: PRZYPADKI.length + 1, bledy };
}

if (require.main === module) {
  const { sprawdzonych, bledy } = uruchomTesty();
  for (const p of PRZYPADKI) {
    const wynik = wskazDuplikaty(p.rows);
    console.log(`--- ${p.nazwa}`);
    console.log(`    ukryto: ${wynik.length ? wynik.map((d) => `#${d.id} (${d.regula})`).join(', ') : 'nic'}`);
  }
  console.log('');
  for (const b of bledy) console.log(`BLAD ${b}`);
  console.log(`Sprawdzono ${sprawdzonych} przypadkow, bledow: ${bledy.length}`);
  process.exit(bledy.length ? 1 : 0);
}

module.exports = { uruchomTesty };
