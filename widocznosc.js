// Kiedy wpis przestaje byc aktualny i znika z appki.
//
// PO CO TO POWSTALO. Do 24.11.2026 appka nie wygaszala wpisow NIGDY. Kazde
// zakonczone zdarzenie zostawalo w niej na zawsze. W zakladce "drogi" wisial
// komunikat PZZD o moscie na Kanale Dychowskim z CZERWCA 2023 roku, a w
// "wodzie" dwie przerwy w Otyniu z pazdziernika, dawno zakonczone. Dla
// mieszkanca appka, ktora obok jutrzejszej awarii pokazuje sprawe sprzed
// trzech lat, przestaje byc wiarygodna w calosci - bo skad ma wiedziec,
// ktory wpis jest prawdziwy.
//
// TRZY REGULY, bo zadna sama nie wystarcza:
//
// 1. NIEOBECNOSC U ZRODLA. Gdy ZWiK albo POMAK usuwa komunikat ze swojej
//    strony, sprawa jest zamknieta - i to najpewniejszy sygnal, jaki mamy,
//    lepszy od liczenia dni. Wymaga kolumny last_seen, odswiezanej przy
//    kazdym zapisie wpisu.
//
// 2. SKRAJNY WIEK. Sama reguła nieobecnosci nie zdjelaby mostu z 2023 roku,
//    bo PZZD trzyma go na liscie do dzis i widzimy go w kazdym cyklu.
//    Dlatego po dostatecznie dlugim czasie chowamy wpis mimo wszystko.
//
// 3. ZDARZENIE JUZ MINELO. Dopisane 25.11.2026, bo dwie powyzsze reguly
//    przepuscily przypadek, ktorego zadna nie obejmowala. ZUK wydal dwa
//    komunikaty o Grabowcu: 23.11 o przerwie 24.11 i 24.11 o dokonczeniu
//    prac 25.11. Oba wisialy obok siebie, prawie identyczne - wygladalo
//    to na zdublowany wpis, a bylo czyms gorszym: wczorajsza przerwa
//    udawala aktualna. Regula 1 jej nie zdjela, bo gmina trzyma oba
//    komunikaty na stronie; regula 2 tez nie, bo wpis mial dwa dni przy
//    progu siedmiu.
//
//    Tu nie liczymy dni, tylko porownujemy DZIEN KALENDARZOWY zdarzenia
//    z dzisiejszym - w strefie Europe/Warsaw, bo serwer chodzi na UTC
//    i miedzy polnoca a pierwsza w nocy "dzis" znaczyloby wczoraj.
//
// PROGI ZALEZA OD KATEGORII i nie jest to ozdobnik. Awaria wody trwa
// godziny, wiec niewidziana od doby jest skonczona. Zamkniecie drogi trwa
// miesiacami, wiec ten sam prog usunalby z appki remonty, ktore wlasnie
// trwaja.
//
// To rozroznienie zalatwia przy okazji najgorszy mozliwy scenariusz: zrodlo
// psuje sie na dobe i zwraca pustke. Wtedy znikaja wpisy o wodzie i pradzie
// - i tak ma byc, bo po dobie bez potwierdzenia naprawde nie wiemy, czy ta
// awaria jeszcze trwa. Komunikaty drogowe zostaja, bo tam doba nic nie
// znaczy. O samej awarii zrodla i tak krzyczy osobny licznik w scrapeAll.
//
// Nic nie jest kasowane z bazy ani oznaczane jako nieaktywne - to filtr
// przy ODCZYCIE. Zly prog cofa sie jednym wdrozeniem, a w panelu admina
// widac caly stan faktyczny.

const polishDates = require('./polishDates');

// WGRYWANIE PLIKU PO PLIKU. Ten plik potrzebuje extractPolishDates, ktore
// dopisalem do polishDates.js tego samego dnia. Pliki ida na serwer przez
// strone GitHuba, pojedynczo, i kazdy z osobna wdraza sie od razu - wiec
// przez kilka minut nowy widocznosc.js chodzi obok STAREGO polishDates.js.
// Bez tej linii leci wtedy "extractPolishDates is not a function" przy
// kazdym odczycie wpisow o wodzie i pradzie, czyli dwie zakladki w appce
// zwracaja blad. Sprawdzone, nie teoretyczne.
//
// Gdy funkcji nie ma, regula 2 po prostu nie dziala - appka zachowuje sie
// dokladnie tak jak przed ta zmiana. To jedyne bezpieczne zachowanie:
// zgadywanie konca zdarzenia z samej daty poczatku chowaloby przerwy,
// ktore wlasnie trwaja. Regula wlacza sie sama, gdy dojedzie drugi plik.
function maParserDat() {
  return typeof polishDates.extractPolishDates === 'function';
}

const DZIEN_MS = 24 * 3600 * 1000;

// Kategorie, w ktorych zdarzenie zamyka sie tego samego dnia, wiec nazajutrz
// na pewno jest po wszystkim. Drog tu NIE MA i nie moze byc: zamkniecie
// ulicy zaczyna sie w podanym dniu i trwa miesiacami, a ta regula zdjelaby
// je nazajutrz po rozpoczeciu - czyli dokladnie wtedy, gdy jest najbardziej
// potrzebne. MZK tak samo (zmiana trasy obowiazuje od dnia X "do odwolania").
const ZDARZENIE_KONCZY_SIE_TEGO_DNIA = new Set(['wodociagi', 'prad']);

const WIDOCZNOSC = {
  // niewidziany u zrodla dluzej niz -> ukryj | starszy niz -> ukryj mimo wszystko
  wodociagi: { nieobecnoscDni: 1, wiekDni: 7 },
  prad: { nieobecnoscDni: 1, wiekDni: 7 },
  mzk: { nieobecnoscDni: 7, wiekDni: 90 },
  drogi: { nieobecnoscDni: 7, wiekDni: 365 },
};

// Kategoria spoza listy (gdyby doszla nowa) dostaje progi najlagodniejsze,
// zeby nowe zrodlo nie zaczelo po cichu znikac, zanim ktos o tym pomysli.
const DOMYSLNE = { nieobecnoscDni: 7, wiekDni: 365 };

function progiDla(kategoria) {
  return WIDOCZNOSC[kategoria] || DOMYSLNE;
}

function czas(wartosc) {
  if (!wartosc) return null;
  const t = Date.parse(wartosc);
  return Number.isFinite(t) ? t : null;
}

/**
 * Od kiedy liczymy wiek wpisu: od PÓŹNIEJSZEJ z dat - publikacji
 * i zdarzenia. Dzieki temu przerwa zapowiedziana z miesiecznym
 * wyprzedzeniem nie zniknie na dzien przed terminem.
 */
function datolicznik(wpis) {
  const publikacja = czas(wpis.published_at);
  const zdarzenie = czas(wpis.event_date);
  if (publikacja === null) return zdarzenie;
  if (zdarzenie === null) return publikacja;
  return Math.max(publikacja, zdarzenie);
}

/**
 * Dzien kalendarzowy w Zielonej Gorze, jako "RRRR-MM-DD".
 *
 * Render chodzi na UTC. Gdybysmy pytali serwer o "dzisiaj", to miedzy
 * polnoca a pierwsza w nocy czasu polskiego (i miedzy polnoca a druga
 * latem) odpowiadalby wczorajsza data - i wpis o dzisiejszej przerwie
 * w dostawie wody znikalby mieszkancowi sprzed nosa akurat w nocy.
 * Format "sv-SE" daje gotowe RRRR-MM-DD, ktore porownuje sie zwyklym <.
 */
function dzienWarszawski(ms) {
  return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Warsaw' });
}

/**
 * Dzien kalendarzowy daty zbudowanej przez parser, jako "RRRR-MM-DD".
 *
 * extractPolishDates robi new Date(rok, miesiac, dzien), czyli polnoc
 * w strefie SERWERA. Gdybysmy taka date przeliczali przez strefe albo
 * porownywali znaczniki czasu, wynik zalezalby od tego, gdzie stoi
 * backend - a to dokladnie ta rodzina bledu, ktora juz raz kazala nam
 * poprawiac testy po wdrozeniu. Czytanie pol lokalnych oddaje dzien
 * dokladnie tak, jak byl zapisany w komunikacie, na kazdym serwerze.
 */
function dzienZParsera(data) {
  const mm = String(data.getMonth() + 1).padStart(2, '0');
  const dd = String(data.getDate()).padStart(2, '0');
  return `${data.getFullYear()}-${mm}-${dd}`;
}

/**
 * Ostatni dzien zdarzenia, jako "RRRR-MM-DD" - albo null, gdy nie wiadomo.
 *
 * Bierzemy NAJPOZNIEJSZA date widoczna w komunikacie, a nie event_date.
 * event_date to data POCZATKU, bo parser zwraca pierwsza date z tekstu.
 * Dla "przerwa od 24.11.2026 do 30.11.2026" byloby to 24.11 i gdybysmy
 * na tym poprzestali, schowalibysmy trwajaca przerwe juz nazajutrz.
 *
 * event_date zostaje w grze jako zabezpieczenie dla zrodel, ktore date
 * podaja osobnym polem, a nie w zdaniu (Enea).
 *
 * Gdy tekst poda date dalsza niz trzeba (np. zapowiedz kolejnego
 * komunikatu), wpis powisi troche dluzej - i tak ma byc. Blad w te
 * strone znaczy "pokazalismy cos zbednego", blad w druga znaczy
 * "ukrylismy trwajaca awarie". Od nadmiaru jest regula 3.
 */
function koniecZdarzenia(wpis) {
  const zdarzenie = czas(wpis.event_date);
  if (zdarzenie === null) return null;

  // Bez parsera dat NIE ZGADUJEMY. Samo event_date to data poczatku, wiec
  // oparcie sie na niej chowaloby przerwy, ktore wlasnie trwaja. Lepiej,
  // zeby regula milczala do czasu, az dojedzie drugi plik.
  if (!maParserDat()) return null;

  let koniec = dzienWarszawski(zdarzenie);
  for (const data of polishDates.extractPolishDates(`${wpis.title || ''} ${wpis.description || ''}`)) {
    const dzien = dzienZParsera(data);
    if (dzien > koniec) koniec = dzien;
  }
  return koniec;
}

/**
 * Dlaczego wpis nie powinien byc widoczny - albo null, gdy ma byc widoczny.
 * Zwracamy powod, a nie samo "nie", zeby dalo sie go wypisac w panelu
 * admina i w logu. Cicho znikajace wpisy juz raz kosztowaly nas w tym
 * projekcie wiele godzin szukania.
 */
function powodUkrycia(wpis, teraz = Date.now()) {
  if (!wpis) return null;
  const progi = progiDla(wpis.category);

  // 1. Zrodlo przestalo wymieniac ten wpis.
  const widziany = czas(wpis.last_seen);
  if (widziany !== null) {
    const dni = (teraz - widziany) / DZIEN_MS;
    if (dni > progi.nieobecnoscDni) {
      return `zrodlo nie wymienia go od ${Math.floor(dni)} dni `
        + `(prog dla "${wpis.category}": ${progi.nieobecnoscDni})`;
    }
  }

  // 2. Zdarzenie odbylo sie przed dzisiejszym dniem.
  if (ZDARZENIE_KONCZY_SIE_TEGO_DNIA.has(wpis.category)) {
    const koniec = koniecZdarzenia(wpis);
    const dzisiaj = dzienWarszawski(teraz);
    if (koniec !== null && koniec < dzisiaj) {
      return `zdarzenie bylo ${koniec}, a dzis mamy ${dzisiaj}`;
    }
  }

  // 3. Skrajny wiek, mimo ze zrodlo wciaz go pokazuje.
  const odniesienie = datolicznik(wpis);
  if (odniesienie !== null) {
    const dni = (teraz - odniesienie) / DZIEN_MS;
    if (dni > progi.wiekDni) {
      return `ma ${Math.floor(dni)} dni `
        + `(prog dla "${wpis.category}": ${progi.wiekDni})`;
    }
  }

  return null;
}

function czyWidoczny(wpis, teraz = Date.now()) {
  return powodUkrycia(wpis, teraz) === null;
}

/**
 * Dzieli wpisy na widoczne i ukryte. Ukryte wracaja z powodem - uzywa tego
 * panel admina, zeby dalo sie sprawdzic, czego appka nie pokazuje i czemu.
 */
function podzielWpisy(wpisy, teraz = Date.now()) {
  const widoczne = [];
  const ukryte = [];
  for (const wpis of wpisy || []) {
    const powod = powodUkrycia(wpis, teraz);
    if (powod) ukryte.push({ wpis, powod });
    else widoczne.push(wpis);
  }
  return { widoczne, ukryte };
}

module.exports = {
  czyWidoczny,
  powodUkrycia,
  podzielWpisy,
  datolicznik,
  koniecZdarzenia,
  dzienWarszawski,
  progiDla,
  ZDARZENIE_KONCZY_SIE_TEGO_DNIA,
  WIDOCZNOSC,
  DOMYSLNE,
  DZIEN_MS,
};
