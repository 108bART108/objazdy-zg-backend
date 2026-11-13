// Przydziela komunikatowi zakladke w aplikacji: mzk / wodociagi / prad / drogi.
//
// UWAGA - ta funkcja dotyczy w praktyce WYLACZNIE artykulow ze strony miasta
// (umZgora.js). Pozostale scrapery ustawiaja kategorie na sztywno: zwik.js
// zawsze 'wodociagi', enea.js 'prad', mzk.js 'mzk', zdw.js 'drogi'. Dlatego
// zmiany tutaj nie moga zepsuc prawdziwych komunikatow o przerwach w dostawie.
//
// ROZROZNIENIE, ktore kosztowalo nas przeoczony komunikat (12.11.2026):
// zakladki "woda" i "prad" znacza dla mieszkanca PRZERWE W DOSTAWIE - "nie
// mam wody w kranie". Artykul "Budowa sieci wodociagowej na al. Konstytucji
// 3 Maja" zawieral slowo "wodociagowej", wiec dawna wersja (sama obecnosc
// slowa "wodoci") wrzucala go do zakladki "woda". A byl to komunikat o
// ROBOTACH, ktore zamykaja fragment ulicy i skrzyzowanie. Mieszkaniec
// szukal go w "drogi" i nie znalazl, a w "woda" trafial na wpis, ktory
// wcale nie zapowiadal braku wody - blad w obie strony naraz.
//
// Dlatego o zakladce "woda"/"prad" decyduje teraz sygnal PRZERWY (awaria,
// brak, przerwa w dostawie), a nie sama nazwa infrastruktury. Budowa,
// przebudowa czy remont sieci to dla mieszkanca zamknieta ulica, czyli
// kategoria "drogi".

const MZK_WORDS = ['mzk', 'autobus', 'linii nr', 'linia nr', 'przystan', 'trolejbus', 'tramwaj', 'rozkład jazdy'];

// Sygnal, ze cos przestalo dzialac albo zaraz przestanie - a nie, ze jest
// budowane. "wy[l]aczeni" celowo wymaga po sobie "pradu"/"energii", zeby
// nie lapac zwrotu "ulica wylaczona z ruchu", ktory jest komunikatem
// drogowym, a nie energetycznym.
const PRZERWA_RE = new RegExp([
  'awari',
  'brak\\w*\\s+(wody|pr[ąa]du|energii)',
  'bez\\s+(wody|pr[ąa]du)',
  'przerw\\w*\\s+w\\s+dostaw',
  'wstrzyman\\w*\\s+dostaw',
  'wy[łl][ąa]czeni\\w*\\s+(pr[ąa]du|energii)',
  'nie\\s+b[ęe]dzie\\s+(wody|pr[ąa]du)',
  'nie\\s+pop[łl]ynie\\s+woda',
].join('|'), 'i');

const WODA_RE = /(wodoci|kanaliz|wody|wod[ęe]|woda|zwik)/i;
const PRAD_RE = /(pr[ąa]d|energi|elektryczn|energetyczn|enea)/i;

function detectCategory(text) {
  const lower = String(text || '').toLowerCase();

  if (MZK_WORDS.some((w) => lower.includes(w))) return 'mzk';

  // Nazwa infrastruktury sama w sobie nie wystarcza - musi towarzyszyc jej
  // sygnal przerwy w dostawie.
  if (PRZERWA_RE.test(lower)) {
    if (WODA_RE.test(lower)) return 'wodociagi';
    if (PRAD_RE.test(lower)) return 'prad';
  }

  return 'drogi';
}

// Wyciaga prawdopodobna nazwe ulicy z tytulu, np. "ul. Waryńskiego", "Sulechowska"
function extractStreet(title) {
  const streetMatch = title.match(/ul\.\s?[A-ZŻŹĆĄŚĘŁÓŃ][\wżźćąśęłóńĄŚĘŁÓŃŻŹĆ.\- ]{2,30}/);
  if (streetMatch) return streetMatch[0].trim().replace(/[.,;:]+$/, '');
  return null;
}

module.exports = { detectCategory, extractStreet };
