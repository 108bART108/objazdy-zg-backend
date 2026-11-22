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

const {
  wskazDuplikaty, MIN_OPIS_DUPLIKATU, REGULA_TRESCI_ZRODLA, MAX_UKRYTYCH_REGULA_TRESCI,
} = require('./db');

// Prawdziwa tresc wpisu Enei: dlugo ponad prog 200 znakow, bo to lista ulic.
const ENEA_TRESC = 'Planowana przerwa w dostawie energii elektrycznej w dniu 22.11.2026 '
  + 'w godzinach od 8:00 do 15:00. Ulice: Akacjowa, Brzozowa, Cisowa, Dębowa, Grabowa, '
  + 'Jarzębinowa, Kasztanowa, Klonowa, Lipowa, Modrzewiowa, Olchowa, Sosnowa, Świerkowa, '
  + 'Topolowa, Wierzbowa, Wiśniowa.';

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

  // --- PRAWDZIWA POMYLKA Z 22.11.2026 -------------------------------------
  // Regula "ta sama tresc pod innym tytulem", wlaczona dla wszystkich zrodel,
  // ukryla 14 powiadomien Enei o wylaczeniach pradu. Enea opisuje jedno
  // wylaczenie pod kilkoma naglowkami obszarow, wiec tresc jest identyczna -
  // ale naglowek obszaru to wlasnie ta informacja, ktora mowi mieszkancowi,
  // ze sprawa dotyczy jego miejscowosci. Zadnego z tych wpisow ukrywac NIE
  // WOLNO i to jest najwazniejszy przypadek w tym pliku.
  {
    nazwa: 'ENEA: jedno wylaczenie pod kilkoma obszarami - WSZYSTKIE musza zostac',
    rows: [
      { id: 1, source_name: 'Enea Operator', category: 'prad', description: ENEA_TRESC, title: 'Obszar Czerwieńsk dzisiaj' },
      { id: 2, source_name: 'Enea Operator', category: 'prad', description: ENEA_TRESC, title: 'Obszar Zielona Góra dzisiaj' },
      { id: 3, source_name: 'Enea Operator', category: 'prad', description: ENEA_TRESC, title: 'Obszar Świdnica dzisiaj' },
      { id: 4, source_name: 'Enea Operator', category: 'prad', description: ENEA_TRESC, title: 'Obszar Świdnica, Zielona Góra dzisiaj' },
      { id: 5, source_name: 'Enea Operator', category: 'prad', description: ENEA_TRESC, title: 'Obszar Nowogród Bobrzański dzisiaj' },
    ],
    ukryte: [],
  },
  {
    nazwa: 'ENEA: ten sam obszar i ta sama tresc dwa razy - to juz prawdziwy duplikat',
    rows: [
      { id: 1, source_name: 'Enea Operator', category: 'prad', description: ENEA_TRESC, title: 'Obszar Świdnica dzisiaj' },
      { id: 2, source_name: 'Enea Operator', category: 'prad', description: ENEA_TRESC, title: 'Obszar Świdnica dzisiaj' },
    ],
    ukryte: [2],
  },
  {
    nazwa: 'BEZPIECZNIK: regula chce ukryc za duzo naraz - nie ukrywa nic',
    rows: [
      { id: 1, source_name: 'PZZD Gorzykowo', category: 'drogi', description: DLUGA_TRESC, title: 'A' },
      { id: 2, source_name: 'PZZD Gorzykowo', category: 'drogi', description: DLUGA_TRESC, title: 'B' },
      { id: 3, source_name: 'PZZD Gorzykowo', category: 'drogi', description: DLUGA_TRESC, title: 'C' },
      { id: 4, source_name: 'PZZD Gorzykowo', category: 'drogi', description: DLUGA_TRESC, title: 'D' },
      { id: 5, source_name: 'PZZD Gorzykowo', category: 'drogi', description: DLUGA_TRESC, title: 'E' },
      { id: 6, source_name: 'PZZD Gorzykowo', category: 'drogi', description: DLUGA_TRESC, title: 'F' },
    ],
    ukryte: [],
  },
  {
    nazwa: 'BEZPIECZNIK nie blokuje starej reguly (ten sam tytul i opis)',
    rows: [
      { id: 1, source_name: 'ZDW Zielona Gora', category: 'drogi', description: 'Remont odcinka.', title: 'Remont DW 278' },
      { id: 2, source_name: 'ZDW Zielona Gora', category: 'drogi', description: 'Remont odcinka.', title: 'Remont DW 278' },
      { id: 3, source_name: 'ZDW Zielona Gora', category: 'drogi', description: 'Remont odcinka.', title: 'Remont DW 278' },
      { id: 4, source_name: 'ZDW Zielona Gora', category: 'drogi', description: 'Remont odcinka.', title: 'Remont DW 278' },
      { id: 5, source_name: 'ZDW Zielona Gora', category: 'drogi', description: 'Remont odcinka.', title: 'Remont DW 278' },
      { id: 6, source_name: 'ZDW Zielona Gora', category: 'drogi', description: 'Remont odcinka.', title: 'Remont DW 278' },
    ],
    ukryte: [2, 3, 4, 5, 6],
  },
];

function uruchomTesty() {
  const bledy = [];

  // Funkcja decyzyjna nie moze NIC wypisywac. Gdy bezpiecznik wolal w niej
  // console.warn, ten wlasnie test - uruchamiany przy kazdym starcie serwera -
  // wstawial do produkcyjnego logu ostrzezenie o wpisach "B", "C", "D", "E",
  // "F". Wygladalo jak awaria appki, a bylo moimi danymi testowymi.
  const wypisane = [];
  const prawdziweWarn = console.warn;
  const prawdziweLog = console.log;
  console.warn = (...a) => wypisane.push(a.join(' '));
  console.log = (...a) => wypisane.push(a.join(' '));

  try {
    for (const p of PRZYPADKI) {
      const { duplikaty } = wskazDuplikaty(p.rows);
      const ukryte = duplikaty.map((d) => d.id).sort((a, b) => a - b);
      const oczekiwane = [...p.ukryte].sort((a, b) => a - b);

      if (ukryte.join(',') !== oczekiwane.join(',')) {
        bledy.push(`${p.nazwa}: ukryto [${ukryte.join(', ')}], a powinno [${oczekiwane.join(', ')}]`);
      }
    }
  } finally {
    console.warn = prawdziweWarn;
    console.log = prawdziweLog;
  }

  if (wypisane.length) {
    bledy.push(`wskazDuplikaty wypisuje do logu ${wypisane.length} linii - a nie powinna zadnej. `
      + `Przy starcie serwera trafiaja one do produkcyjnego logu jako falszywy alarm. `
      + `Pierwsza: "${wypisane[0].slice(0, 120)}"`);
  }

  // Bezpiecznik musi oddawac wstrzymane wpisy wolajacemu - inaczej nikt sie
  // nie dowie, ze w ogole zadzialal.
  const zaDuzo = PRZYPADKI.find((p) => p.nazwa.startsWith('BEZPIECZNIK: regula chce ukryc'));
  if (zaDuzo) {
    const { wstrzymane } = wskazDuplikaty(zaDuzo.rows);
    if (wstrzymane.length !== 5) {
      bledy.push(`bezpiecznik powinien oddac 5 wstrzymanych wpisow, oddal ${wstrzymane.length} `
        + '- bez tego ostrzezenie nigdy nie trafi do logu');
    }
  }

  // Prog dlugosci jest sercem tej reguly: za nisko ustawiony zaczyna wyciszac
  // rozne komunikaty o podobnym, krotkim opisie.
  if (MIN_OPIS_DUPLIKATU < 150) {
    bledy.push(`prog MIN_OPIS_DUPLIKATU = ${MIN_OPIS_DUPLIKATU} jest za niski - `
      + 'krotkie, przypadkowo zbiezne opisy zaczna byc uznawane za duplikaty');
  }

  // Enea ponad wszystko: to jej 14 ostrzezen o pradzie zniklo 22.11.2026.
  // Zadne zrodlo, ktore opisuje jedno zdarzenie pod kilkoma naglowkami, nie
  // moze trafic na te liste.
  for (const zabronione of ['Enea Operator', 'Enea', 'UM Zielona Gora', 'ZDW Zielona Gora', 'MZK', 'ZWiK']) {
    if (REGULA_TRESCI_ZRODLA.includes(zabronione)) {
      bledy.push(`zrodlo "${zabronione}" nie moze byc objete regula "ta sama tresc pod innym `
        + 'tytulem" - tak wlasnie zniknely powiadomienia o wylaczeniach pradu');
    }
  }

  if (MAX_UKRYTYCH_REGULA_TRESCI > 5) {
    bledy.push(`bezpiecznik MAX_UKRYTYCH_REGULA_TRESCI = ${MAX_UKRYTYCH_REGULA_TRESCI} jest za luzny `
      + '- przy takiej wartosci pomylka reguly znowu schowa wiele wpisow naraz');
  }

  return { sprawdzonych: PRZYPADKI.length + 5, bledy };
}

if (require.main === module) {
  const { sprawdzonych, bledy } = uruchomTesty();
  for (const p of PRZYPADKI) {
    const { duplikaty, wstrzymane } = wskazDuplikaty(p.rows);
    console.log(`--- ${p.nazwa}`);
    console.log(`    ukryto: ${duplikaty.length ? duplikaty.map((d) => `#${d.id} (${d.regula})`).join(', ') : 'nic'}`);
    if (wstrzymane.length) {
      console.log(`    bezpiecznik wstrzymal: ${wstrzymane.map((d) => `"${d.title}"`).join(', ')}`);
    }
  }
  console.log('');
  for (const b of bledy) console.log(`BLAD ${b}`);
  console.log(`Sprawdzono ${sprawdzonych} przypadkow, bledow: ${bledy.length}`);
  process.exit(bledy.length ? 1 : 0);
}

module.exports = { uruchomTesty };
