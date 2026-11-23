// Test wyszukiwania po nazwie ulicy i miejscowości.
// Uruchomienie:  node testSzukania.js
//
// Wpisy ponizej to PRAWDZIWE komunikaty z appki - tytuly i ulice przepisane
// z logow produkcyjnych oraz z sond. Zapytania sa takie, jakie wpisalby
// mieszkaniec na telefonie - czyli w polowie przypadkow bez ogonkow.
//
// Powod powstania: dzisiejsze szukanie w bazie (SQL LIKE) przepuszczalo
// 13 z 21 takich zapytan. Pozostale osiem to byly wylacznie polskie znaki
// i odmiana: "Dabrowskiego", "Ploty", "jasinskiego", "swidnica", "zaciszu".
// Mieszkaniec, ktory nie stawia ogonkow, nie znajdowal WLASNEJ ulicy.

const {
  szukaj, pasuje, normalizuj, rdzen, normalizujKategorie, policzKategorie, KATEGORIE,
} = require('./szukanie');

// [kategoria, tytul, ulica, opis]
const WPISY = [
  ['drogi', 'Budowa sieci wodociągowej na al. Konstytucji 3 Maja', 'al. Konstytucji 3 Maja',
    'Roboty rozpoczną się w rejonie skrzyżowania ulic Moniuszki, Długiej i al. Konstytucji 3 Maja.'],
  ['drogi', 'Koniec męczarni na Fioletowej i Jasińskiego – drogi do remontu!', 'ul. Fioletowa',
    'Remont ulic Fioletowej i Jasińskiego w Zielonej Górze.'],
  ['drogi', 'Trzy skrzyżowania do przebudowy. Powstaną tu ronda pinezkowe', null,
    'Przebudowa skrzyżowań w rejonie ul. Wyszyńskiego i ul. Chrobrego.'],
  ['mzk', 'Przywrócenie kursowania przez ul. Zacisze - od 19.10.', 'ul. Zacisze',
    'Przywrócenie ruchu dwukierunkowego na ul. Zacisze, zamknięcie ul. Działkowej.'],
  ['drogi', 'Zamknięcie drogi powiatowej nr 1181F', 'droga powiatowa nr 1181F',
    'Zamknięcie odcinka drogi powiatowej 1181F relacji Słone - Buchałów.'],
  ['wodociagi', 'Awaria sieci wodociągowej na ul. Dąbrowskiego', 'ul. Dąbrowskiego',
    'Brak wody do godz. 14 na ul. Dąbrowskiego.'],
  ['wodociagi', 'Czerwieńsk: Przerwa w dostawie wody - Płoty', 'Płoty',
    'Przerwa w dostawie wody w miejscowości Płoty, na ulicach: Letnia, Pogodna, Wiosenna.'],
  ['wodociagi', 'Czerwieńsk: UWAGA MIESZKAŃCY NIETKOWA', 'Nietków',
    'Awaria sieci wodociągowej w miejscowości Nietków.'],
  ['wodociagi', 'Nowogród Bobrzański: Przerwa w dostawie wody w Bogaczowie', null,
    'Przerwa w dostawie wody w Bogaczowie'],
  ['prad', 'Obszar Zielona Góra dzisiaj', null,
    'Wyłączenie prądu: ul. Botaniczna, ul. Wrocławska, ul. Łużycka.'],
  ['prad', 'Obszar Świdnica dzisiaj', null,
    'Planowana przerwa w dostawie energii: Świdnica, Koźla, Wilkanowo.'],
].map(([category, title, street, description]) => ({ category, title, street, description }));

function wKategorii(kategoria) {
  return WPISY.filter((w) => w.category === kategoria);
}

// [kategoria, fraza, ile ma wyjsc, po co ten przypadek]
const PRZYPADKI = [
  // --- podstawy ------------------------------------------------------------
  ['mzk', 'Zacisze', 1, 'wpisane dokładnie'],
  ['mzk', 'zacisze', 1, 'mała litera'],
  ['drogi', '1181F', 1, 'numer drogi powiatowej'],
  ['drogi', 'konstytucji 3', 1, 'dwa słowa - oba muszą pasować'],

  // --- POLSKIE ZNAKI: tak pisze sie na telefonie ---------------------------
  ['wodociagi', 'Dąbrowskiego', 1, 'z ogonkami'],
  ['wodociagi', 'Dabrowskiego', 1, 'BEZ ogonków - tu zawodziło SQL'],
  ['wodociagi', 'Płoty', 1, 'z ogonkiem'],
  ['wodociagi', 'Ploty', 1, 'BEZ ogonka - tu zawodziło SQL'],
  ['drogi', 'jasinskiego', 1, 'bez ogonków i małą literą'],
  ['prad', 'swidnica', 1, 'bez ogonka'],
  ['prad', 'wroclawska', 1, 'ulica wymieniona tylko w opisie'],
  ['prad', 'luzycka', 1, 'ulica z "ł" - normalize() samo go nie rozkłada'],

  // --- ODMIANA -------------------------------------------------------------
  ['mzk', 'zaciszu', 1, 'odmiana: w komunikacie "na Zaciszu"'],
  ['wodociagi', 'Płotów', 1, 'dopełniacz'],
  ['wodociagi', 'plotow', 1, 'dopełniacz bez ogonków'],
  ['wodociagi', 'nietkowa', 1, 'w tytule "NIETKOWA", szukamy odmiany'],
  ['wodociagi', 'Nietków', 1, 'mianownik, a w tytule dopełniacz'],
  ['wodociagi', 'Bogaczów', 1, 'mianownik, w tytule "w Bogaczowie"'],

  // --- CZEGO ZNALEZC NIE WOLNO --------------------------------------------
  // To wazniejsza polowa testu. Dopasowanie po rdzeniu latwo rozjezdza sie
  // w druga strone i zaczyna pokazywac ulice, o ktore nikt nie pytal.
  ['drogi', 'Kowalskiego', 0, 'ulica, której nie ma w żadnym komunikacie'],
  ['drogi', 'xyz', 0, 'ciąg znaków bez sensu'],
  ['mzk', 'Dąbrowskiego', 0, 'ulica istnieje, ale w INNEJ kategorii'],
  ['drogi', 'Chrobrego Kowalskiego', 0, 'jedno słowo pasuje, drugie nie - ma nie wejść'],
  ['wodociagi', 'Letnia Wiosenna', 1, 'oba słowa w tym samym komunikacie'],
  ['prad', 'Botaniczna Kowalskiego', 0, 'jedno pasuje, drugie nie'],

  // Ten przypadek wylapal prawdziwy blad: dopasowanie po rdzeniu dzialalo
  // w obie strony, wiec przyimek "w" z opisu pasowal do KAZDEGO zapytania
  // zaczynajacego sie na "w". Szukanie ulicy Wroclawskiej wyciagalo
  // komunikat ze Swidnicy, gdzie takiej ulicy nie ma.
  ['prad', 'wroclawska', 1, 'NIE moze trafic w komunikat ze Świdnicy przez przyimek "w"'],
  ['prad', 'wilkanowo', 1, 'miejscowość tylko w jednym komunikacie'],
  ['wodociagi', 'woda', 0, 'słowo pospolite, nie nazwa - nie ma żadnej ulicy "Woda"'],
];

const bledy = [];
function sprawdz(warunek, opis) {
  if (!warunek) bledy.push(opis);
}

for (const [kategoria, fraza, ile, po_co] of PRZYPADKI) {
  const wynik = szukaj(wKategorii(kategoria), fraza);
  if (wynik.length !== ile) {
    bledy.push(`"${fraza}" [${kategoria}]: ${wynik.length} wynikow, oczekiwano ${ile} (${po_co})`
      + (wynik.length ? ` -> ${wynik.map((w) => `"${w.title}"`).join(', ')}` : ''));
  }
}

// --- puste i bardzo krotkie zapytania ---------------------------------------
// Dopoki nie ma czym zawezac, pokazujemy wszystko. Inaczej mieszkaniec,
// ktory zaczal pisac "ul..." albo "Dą...", widzi przez chwile pusta liste.
const wodociagi = wKategorii('wodociagi');
for (const fraza of ['', '   ', 'ul', 'a', 'w']) {
  sprawdz(szukaj(wodociagi, fraza).length === wodociagi.length,
    `fraza "${fraza}": przy zbyt krotkim wpisie lista ma zostac nietknieta, `
    + `a zostalo ${szukaj(wodociagi, fraza).length} z ${wodociagi.length}`);
}

// --- same funkcje pomocnicze -------------------------------------------------
sprawdz(normalizuj('Dąbrowskiego') === 'dabrowskiego', `normalizuj: "${normalizuj('Dąbrowskiego')}"`);
sprawdz(normalizuj('Płoty') === 'ploty', `normalizuj: "${normalizuj('Płoty')}"`);
sprawdz(normalizuj('ŁUŻYCKA') === 'luzycka', `normalizuj: "${normalizuj('ŁUŻYCKA')}"`);
sprawdz(normalizuj('Świdnica') === 'swidnica', `normalizuj: "${normalizuj('Świdnica')}"`);
sprawdz(normalizuj('  Zielona   Góra  ') === 'zielona gora', `normalizuj: "${normalizuj('  Zielona   Góra  ')}"`);

// Rdzen nie moze schodzic ponizej czterech liter - inaczej krotkie nazwy
// zaczelyby pasowac do wszystkiego.
sprawdz(rdzen('Płotów') === 'plot', `rdzen("Płotów") = "${rdzen('Płotów')}"`);
sprawdz(rdzen('Zacisze') === 'zacis', `rdzen("Zacisze") = "${rdzen('Zacisze')}"`);
sprawdz(rdzen('Lesna').length >= 4, `rdzen("Lesna") = "${rdzen('Lesna')}" - za krotki`);
sprawdz(rdzen('ul') === 'ul', 'rdzen: bardzo krotkie slowo zostaje bez zmian');

// Pojedynczy wpis - sprawdzenie bez listy.
const zacisze = WPISY.find((w) => w.street === 'ul. Zacisze');
sprawdz(pasuje(zacisze, 'Zacisze'), 'pasuje: dokladne trafienie');
sprawdz(pasuje(zacisze, 'dzialkowej'), 'pasuje: ulica wymieniona tylko w opisie, bez ogonkow');
sprawdz(!pasuje(zacisze, 'Kowalskiego'), 'pasuje: obca ulica nie moze trafic');
sprawdz(!pasuje({ title: null, street: null, description: null }, 'cokolwiek'),
  'pasuje: pusty wpis nie moze trafiac');

// ======================= KATEGORIE: CO WOLNO WYSLAC =========================
// Proba na prawdziwym API pokazala, ze doslowne porownanie nazwy kategorii
// zwraca PUSTA LISTE dla wszystkiego poza doslowna mala nazwa - a pusta
// lista wyglada dla mieszkanca jak "nie ma zadnych utrudnien", nie jak blad.
// Najgrozniejsze byly "wodociągi" i "prąd" pisane z ogonkami, czyli tak,
// jak nazywaja sie ZAKLADKI widziane w appce.

// [co przychodzi, jaka kategoria ma wyjsc, czy rozpoznana, po co ten przypadek]
const KATEGORIE_PRZYPADKI = [
  // --- wszystkie kategorie ------------------------------------------------
  ['all', null, true, 'podstawowa forma'],
  ['ALL', null, true, 'wielkie litery - dawniej 0 wynikow'],
  ['All', null, true, 'z duzej - dawniej 0 wynikow'],
  [' all ', null, true, 'ze spacjami - dawniej 0 wynikow'],
  ['wszystko', null, true, 'po polsku'],
  ['wszystkie', null, true, 'po polsku, liczba mnoga'],
  ['', null, true, 'puste'],
  ['   ', null, true, 'same spacje'],
  [null, null, true, 'brak wartosci'],
  [undefined, null, true, 'parametr nieprzeslany'],

  // --- konkretne kategorie -------------------------------------------------
  ['drogi', 'drogi', true, 'poprawna nazwa'],
  ['Drogi', 'drogi', true, 'z duzej - dawniej 0 wynikow'],
  ['DROGI', 'drogi', true, 'wielkie litery'],
  [' drogi ', 'drogi', true, 'ze spacjami'],
  ['wodociagi', 'wodociagi', true, 'poprawna nazwa'],
  ['wodociągi', 'wodociagi', true, 'Z OGONKIEM - tak nazywa sie zakladka'],
  ['Wodociągi', 'wodociagi', true, 'z ogonkiem i z duzej'],
  ['prad', 'prad', true, 'poprawna nazwa'],
  ['prąd', 'prad', true, 'Z OGONKIEM - tak nazywa sie zakladka'],
  ['Prąd', 'prad', true, 'z ogonkiem i z duzej'],
  ['mzk', 'mzk', true, 'poprawna nazwa'],
  ['MZK', 'mzk', true, 'skrot wielkimi literami - tak sie go pisze'],

  // --- formy potoczne ------------------------------------------------------
  ['woda', 'wodociagi', true, 'potoczna nazwa'],
  ['energia', 'prad', true, 'potoczna nazwa'],
  ['autobusy', 'mzk', true, 'potoczna nazwa'],
  ['komunikacja', 'mzk', true, 'potoczna nazwa'],
  ['ulice', 'drogi', true, 'potoczna nazwa'],

  // --- czego nie znamy -----------------------------------------------------
  // Nieznana wartosc ma dac WSZYSTKIE wpisy, nie zero. Mieszkaniec dostaje
  // wyniki, a blad frontendu widac w logu. Odwrotnie byloby cicha awaria.
  ['xyz', null, false, 'nieistniejaca kategoria'],
  ['smieci', null, false, 'kategoria, ktorej appka nie ma'],
  ['drog', null, false, 'literowka - nie zgadujemy'],
];

for (const [wejscie, oczekiwana, maBycRozpoznana, po_co] of KATEGORIE_PRZYPADKI) {
  const { kategoria, rozpoznana } = normalizujKategorie(wejscie);
  const etykieta = wejscie === undefined ? 'undefined' : JSON.stringify(wejscie);
  sprawdz(kategoria === oczekiwana,
    `kategoria ${etykieta}: wyszlo ${JSON.stringify(kategoria)}, oczekiwano `
    + `${JSON.stringify(oczekiwana)} (${po_co})`);
  sprawdz(rozpoznana === maBycRozpoznana,
    `kategoria ${etykieta}: rozpoznana=${rozpoznana}, oczekiwano ${maBycRozpoznana} (${po_co})`);
}

// Kazda nazwa z bazy musi przejsc przez normalizacje bez zmian - inaczej
// zakladka przestalaby dzialac po cichu.
for (const k of KATEGORIE) {
  sprawdz(normalizujKategorie(k).kategoria === k,
    `kategoria "${k}": wlasna nazwa z bazy nie przechodzi przez normalizacje`);
}

// Zaden alias nie moze wskazywac na kategorie, ktorej nie ma.
const { ALIASY } = require('./szukanie');
for (const [alias, cel] of Object.entries(ALIASY)) {
  sprawdz(KATEGORIE.includes(cel),
    `alias "${alias}" wskazuje na nieistniejaca kategorie "${cel}"`);
}

// ======================= SZUKANIE PONAD KATEGORIAMI =========================
// To jest sedno pola "szukaj we wszystkich kategoriach": mieszkaniec szuka
// swojej ulicy, ale stoi w zlej zakladce.
const licznik = policzKategorie(WPISY, 'Zacisze');
sprawdz(licznik.mzk === 1, `licznik: "Zacisze" w mzk = ${licznik.mzk}, oczekiwano 1`);
sprawdz(licznik.drogi === 0, `licznik: "Zacisze" w drogach = ${licznik.drogi}, oczekiwano 0`);

// Ulica wymieniona w dwoch roznych kategoriach - licznik ma pokazac obie.
const WPISY_Z_DWOCH = [...WPISY, {
  category: 'drogi',
  title: 'Zamknięcie ul. Zacisze na czas remontu',
  street: 'ul. Zacisze',
  description: 'Odcinek ul. Zacisze nieprzejezdny.',
}];
const licznik2 = policzKategorie(WPISY_Z_DWOCH, 'zaciszu');
sprawdz(licznik2.mzk === 1 && licznik2.drogi === 1,
  `licznik: ta sama ulica w dwoch kategoriach -> mzk=${licznik2.mzk}, drogi=${licznik2.drogi}`);

// Licznik zawsze wymienia WSZYSTKIE kategorie, takze te z zerem - appka
// musi miec z czego zbudowac zdanie "w wodociagach sa 2 wyniki".
const licznik3 = policzKategorie(WPISY, 'Kowalskiego');
for (const k of KATEGORIE) {
  sprawdz(licznik3[k] === 0, `licznik: dla nieistniejacej ulicy "${k}" ma byc 0, jest ${licznik3[k]}`);
  sprawdz(Object.prototype.hasOwnProperty.call(licznik3, k),
    `licznik: brakuje kategorii "${k}" w wyniku`);
}

// Pusta fraza - licznik nie moze sie wywrocic.
const licznik4 = policzKategorie(WPISY, '');
sprawdz(KATEGORIE.every((k) => typeof licznik4[k] === 'number'),
  'licznik: pusta fraza ma dac liczby, nie wyjatek');
sprawdz(policzKategorie([], 'Zacisze').mzk === 0, 'licznik: pusta lista wpisow');

const LICZBA_WARUNKOW = PRZYPADKI.length + 5 + 5 + 4 + 4
  + (KATEGORIE_PRZYPADKI.length * 2) + KATEGORIE.length + Object.keys(ALIASY).length
  + 3 + (KATEGORIE.length * 2) + 2;

function uruchomTesty() {
  return { sprawdzonych: LICZBA_WARUNKOW, bledy };
}

if (require.main === module) {
  for (const [kategoria, fraza] of PRZYPADKI) {
    const wynik = szukaj(wKategorii(kategoria), fraza);
    console.log(`[${kategoria.padEnd(10)}] "${fraza}" -> ${wynik.length}`);
    wynik.forEach((w) => console.log(`              ${w.title}`));
  }
  console.log('');
  for (const b of bledy) console.log(`BLAD ${b}`);
  console.log(`Sprawdzono ${LICZBA_WARUNKOW} warunkow, bledow: ${bledy.length}`);
  process.exit(bledy.length ? 1 : 0);
}

module.exports = { uruchomTesty };
