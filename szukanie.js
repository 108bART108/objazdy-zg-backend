// Wyszukiwanie wpisów po nazwie ulicy albo miejscowości.
//
// PO CO OSOBNY PLIK: baza umie juz szukac (listUtrudnienia przyjmuje
// "search" i robi SQL LIKE), ale na polskich nazwach to zawodzi w dwoch
// miejscach i proba na prawdziwych wpisach appki pokazala, w ktorych:
//
//   "Dabrowskiego"  -> 0 wynikow (w bazie jest "Dąbrowskiego")
//   "Ploty"         -> 0 wynikow (w bazie jest "Płoty")
//   "jasinskiego"   -> 0 wynikow (w bazie jest "Jasińskiego")
//   "swidnica"      -> 0 wynikow (w bazie jest "Świdnica")
//   "zaciszu"       -> 0 wynikow (w bazie jest "Zacisze")
//
// Pierwsze cztery to ten sam problem: LIKE w SQLite rozroznia wielkosc
// liter tylko dla ASCII, a ogonkow nie sprowadza do liter bez ogonkow.
// Mieszkaniec piszacy na telefonie zwykle ogonkow nie stawia - i wtedy
// nie znajduje WLASNEJ ulicy. To najgorszy mozliwy wynik wyszukiwarki.
//
// Piate to odmiana: szuka sie "Zacisze", a w komunikacie stoi "na Zaciszu".
//
// DLACZEGO W JAVASCRIPCIE, A NIE W SQL: appka trzyma kilkadziesiat
// aktywnych wpisow (dzis 66). Przy takiej skali filtrowanie w pamieci jest
// natychmiastowe, a daje pelna kontrole nad polskim - w SQL wymagaloby to
// dodatkowej kolumny znormalizowanej albo rozszerzenia ICU, ktorego na
// Renderze nie ma. Gdyby wpisow bylo dziesiatki tysiecy, trzeba by wrocic
// do indeksu w bazie.

// Ogonki -> litery bez ogonkow. "ł" wymaga osobnej linii, bo normalize('NFD')
// go nie rozklada (to osobny znak, a nie "l" z kreska).
const OGONKI = { ł: 'l', Ł: 'L' };

function normalizuj(tekst) {
  return String(tekst || '')
    .replace(/[łŁ]/g, (z) => OGONKI[z])
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

// Minimalna dlugosc slowa, ktore w ogole bierzemy pod uwage. Krotsze
// ("w", "na", "ul") nic nie wnosza, a pasowalyby do wszystkiego.
const MIN_DL_SLOWA = 3;

// Ile liter zostawiamy, szukajac rdzenia. Polskie koncowki fleksyjne maja
// zwykle 1-2 litery ("Ploty" -> "Plotow", "Zacisze" -> "Zaciszu"), wiec
// obcinamy dwie, ale nigdy ponizej czterech liter - inaczej "Lesna" zeszloby
// do "Le" i pasowalo do polowy miasta.
const MIN_DL_RDZENIA = 4;

function rdzen(slowo) {
  const s = normalizuj(slowo);
  if (s.length <= MIN_DL_RDZENIA) return s;
  return s.substring(0, Math.max(MIN_DL_RDZENIA, s.length - 2));
}

/**
 * Z czego budujemy "siano", w ktorym szukamy igly. Tytul, ulica i opis -
 * dokladnie te trzy pola, po ktorych szuka dzis SQL, zeby zmiana nie
 * zawezila wynikow w stosunku do stanu obecnego.
 */
function sianoWpisu(wpis) {
  return normalizuj([wpis.title, wpis.street, wpis.description].filter(Boolean).join(' '));
}

/**
 * Czy wpis pasuje do frazy. Fraza moze byc wielowyrazowa ("konstytucji 3
 * maja") - wtedy KAZDE slowo musi gdzies pasowac, zeby "ulica kowalskiego"
 * nie wyciagalo wszystkiego, co ma slowo "ulica".
 */
function uzyteczneSlowa(fraza) {
  return normalizuj(fraza).split(' ').filter((s) => s.length >= MIN_DL_SLOWA);
}

function pasuje(wpis, fraza) {
  const siano = sianoWpisu(wpis);
  if (!siano) return false;

  const slowa = uzyteczneSlowa(fraza);
  if (!slowa.length) return false;

  const slowaSiana = siano.split(/[^0-9a-z]+/).filter(Boolean);

  return slowa.every((slowo) => {
    // 1. Trafienie wprost - po sprowadzeniu obu stron do liter bez ogonkow.
    if (siano.includes(slowo)) return true;

    // 2. Odmiana: porownujemy rdzenie. "zaciszu" -> "zacis", a w tekscie
    //    "zacisze" -> tez zaczyna sie od "zacis".
    const r = rdzen(slowo);
    if (r.length < MIN_DL_RDZENIA) return false;

    return slowaSiana.some((s) => {
      if (s.startsWith(r)) return true;

      // Porownanie w druga strone ("Plotach" wpisane, "Ploty" w tekscie)
      // tylko dla slow, ktore same maja sensowny rdzen. Bez tego warunku
      // przyimek "w" z opisu ("w dostawie wody") pasowal do KAZDEGO
      // zapytania zaczynajacego sie na "w" - i szukanie ulicy Wroclawskiej
      // wyciagalo komunikat ze Swidnicy, gdzie takiej ulicy nie ma.
      const rs = rdzen(s);
      return rs.length >= MIN_DL_RDZENIA && r.startsWith(rs);
    });
  });
}

/**
 * Filtruje liste wpisow. Kolejnosc wejsciowa zostaje bez zmian - lista
 * w appce ma byc uporzadkowana od najnowszego wpisu, a nie wedlug tego,
 * jak dobrze cos pasuje do wpisanego slowa.
 */
function szukaj(wpisy, fraza) {
  if (!fraza || !String(fraza).trim()) return wpisy;

  // Dopoki w oknie nie ma ani jednego slowa dluzszego niz dwie litery,
  // nie filtrujemy nic. Inaczej mieszkaniec, ktory zaczal pisac "ul..."
  // albo "Dą...", widzi przez chwile PUSTA liste i mysli, ze nic nie ma.
  // Lepiej pokazac wszystko i zawezac dopiero, gdy jest czym.
  if (!uzyteczneSlowa(fraza).length) return wpisy;

  return (wpisy || []).filter((w) => pasuje(w, fraza));
}

// ============================ KATEGORIE =====================================
// Nazwy kategorii, ktore appka trzyma w bazie. Zakladki widziane przez
// mieszkanca nazywaja sie inaczej ("Wodociągi", "Prąd") - i wlasnie na tym
// mozna sie przejechac.
const KATEGORIE = ['drogi', 'mzk', 'wodociagi', 'prad'];

// Proba na prawdziwym API pokazala, ze dzisiaj dziala WYLACZNIE doslowna,
// mala nazwa. Wszystko inne po cichu zwraca pusta liste:
//
//   "ALL", "All", " all "  -> 0 wpisow (zamiast wszystkich)
//   "Drogi", "DROGI"       -> 0 wpisow
//   "wodociągi" (ogonek)   -> 0 wpisow  <- tak nazywa sie ZAKLADKA
//   "prąd"      (ogonek)   -> 0 wpisow  <- tak nazywa sie ZAKLADKA
//
// Pusta lista nie wyglada jak blad - wyglada jak "nie ma zadnych utrudnien".
// To najgorszy rodzaj awarii w takiej appce: cicha i wiarygodna.
const ALIASY = {
  // widoczne nazwy zakladek i formy potoczne
  woda: 'wodociagi',
  wodociag: 'wodociagi',
  wodociagow: 'wodociagi',
  zwik: 'wodociagi',
  energia: 'prad',
  elektrycznosc: 'prad',
  enea: 'prad',
  autobus: 'mzk',
  autobusy: 'mzk',
  komunikacja: 'mzk',
  droga: 'drogi',
  ulica: 'drogi',
  ulice: 'drogi',
  objazdy: 'drogi',
};

const WSZYSTKIE = ['all', 'wszystko', 'wszystkie', 'kazda', 'dowolna'];

/**
 * Sprowadza to, co przyszlo w zapytaniu, do nazwy kategorii z bazy.
 *
 * Zwraca { kategoria, rozpoznana }:
 *   kategoria   - nazwa z bazy albo null, gdy szukamy we wszystkich,
 *   rozpoznana  - false, gdy przyszlo cos, czego nie umiemy nazwac.
 *
 * Nieznana wartosc celowo oznacza "wszystkie", a nie "nic": mieszkaniec
 * dostanie wtedy wyniki zamiast pustego ekranu, a blad frontendu widac
 * w logu. Odwrotny wybor ukrywalby awarie przed wszystkimi naraz.
 */
function normalizujKategorie(kategoria) {
  const k = normalizuj(kategoria);
  if (!k) return { kategoria: null, rozpoznana: true };
  if (WSZYSTKIE.includes(k)) return { kategoria: null, rozpoznana: true };
  if (KATEGORIE.includes(k)) return { kategoria: k, rozpoznana: true };
  if (ALIASY[k]) return { kategoria: ALIASY[k], rozpoznana: true };
  return { kategoria: null, rozpoznana: false };
}

/**
 * Ile wpisow pasuje do frazy w KAZDEJ kategorii osobno.
 *
 * Po to, zeby appka mogla powiedziec "w drogach nic nie ma, ale sa 2 wyniki
 * w wodociagach" - zamiast pokazac pusty ekran komus, kto szuka swojej ulicy
 * i nie wie, ze stoi w zlej zakladce. To jest wlasciwy powod, dla ktorego
 * pole "szukaj we wszystkich kategoriach" w ogole ma sens.
 */
function policzKategorie(wpisy, fraza) {
  const wynik = {};
  for (const k of KATEGORIE) wynik[k] = 0;
  for (const w of szukaj(wpisy, fraza)) {
    const k = normalizuj(w.category);
    if (!k) continue;
    wynik[k] = (wynik[k] || 0) + 1;
  }
  return wynik;
}

module.exports = {
  szukaj, pasuje, normalizuj, rdzen, sianoWpisu, uzyteczneSlowa,
  normalizujKategorie, policzKategorie,
  KATEGORIE, ALIASY, WSZYSTKIE, MIN_DL_SLOWA, MIN_DL_RDZENIA,
};
