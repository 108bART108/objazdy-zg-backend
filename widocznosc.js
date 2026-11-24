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
// DWIE REGULY, bo zadna sama nie wystarcza:
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

const DZIEN_MS = 24 * 3600 * 1000;

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

  // 2. Skrajny wiek, mimo ze zrodlo wciaz go pokazuje.
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
  progiDla,
  WIDOCZNOSC,
  DOMYSLNE,
  DZIEN_MS,
};
