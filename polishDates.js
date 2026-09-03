// polishDates.js
//
// Wspolny parser polskich dat w formie tekstowej ("31 sierpnia",
// "1 września 2026 r.", "od poniedzialku (31 sierpnia) do piatku
// (4 wrzesnia)") - uzywany przez scrapery, ktore NIE maja gotowego
// pola daty w danych zrodlowych (MZK, ZWiK), zeby rowniez mogly
// wystawiac event_date i appka pokazywala im ta sama zolta plakietke
// "Dzisiaj"/"Jutro"/"za X dni", co juz dziala dla Enea i ZDW.

const MONTHS = {
  stycznia: 0, lutego: 1, marca: 2, kwietnia: 3, maja: 4, czerwca: 5,
  lipca: 6, sierpnia: 7, września: 8, wrzesnia: 8, października: 9, pazdziernika: 9,
  listopada: 10, grudnia: 11,
};

const MONTH_NAMES_RE = Object.keys(MONTHS).join('|');

/**
 * Znajduje PIERWSZA date w tekscie - zarowno w formie slownej ("31
 * sierpnia", "1 września 2026 r."), jak i liczbowej ("27.08.2026",
 * "27.08.") - ta druga forma jest bardzo czesta w oficjalnych
 * komunikatach urzedowych (RSS Urzedu Miasta, ZWiK) i bez jej obslugi
 * wiekszosc wpisow w kategoriach Drogi/Wodociagi nigdy nie dostawala
 * event_date, mimo ze data byla w tekscie - po prostu w innym formacie
 * niz ten, ktory umielismy rozpoznac.
 *
 * Gdy w tekscie wystepuja oba formaty, wygrywa ten, ktory pojawia sie
 * WCZESNIEJ w tekscie (pierwsza wzmianka o dacie = zazwyczaj najbardziej
 * istotna, np. data rozpoczecia utrudnienia).
 *
 * @param {string} text
 * @param {Date} now - do rozstrzygania roku, gdy nie jest podany w tekscie
 * @returns {Date|null}
 */
function extractPolishDate(text, now = new Date()) {
  if (!text) return null;

  const candidates = [];

  // Format slowny: "31 sierpnia", "1 września 2026 r."
  const wordRe = new RegExp(`(\\d{1,2})\\s+(${MONTH_NAMES_RE})(?:\\s+(\\d{4}))?`, 'giu');
  let m;
  while ((m = wordRe.exec(text))) {
    candidates.push({ index: m.index, day: Number(m[1]), month: MONTHS[m[2].toLowerCase()], year: m[3] ? Number(m[3]) : null });
  }

  // Format liczbowy: "27.08.2026" lub "27.08" (bez roku)
  const numRe = /\b(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?\b/g;
  while ((m = numRe.exec(text))) {
    const day = Number(m[1]);
    const month = Number(m[2]) - 1;
    if (month < 0 || month > 11 || day < 1 || day > 31) continue; // nie data - odrzuc
    candidates.push({ index: m.index, day, month, year: m[3] ? Number(m[3]) : null });
  }

  if (!candidates.length) return null;
  candidates.sort((a, b) => a.index - b.index);
  const best = candidates[0];

  let year = best.year || now.getFullYear();
  let d = new Date(year, best.month, best.day);
  if (isNaN(d.getTime())) return null;

  // Brak roku w tekscie: rok "przeskakuje" na przyszly TYLKO gdy data
  // wypadalaby ponad 300 dni w przeszlosci - to praktycznie jedyny
  // sensowny sygnal "to na pewno przyszly rok" (np. "3 stycznia"
  // wspomniane w grudniu). Przy mniejszych odstepach (np. ogloszenie
  // z lipca czytane we wrzesniu, ~60-90 dni wstecz) to zwykle po prostu
  // NIEDAWNA przeszlosc - proba "naprawy" na przyszly rok psuje wiecej
  // niz naprawia (patrz: blad "za 302 dni" dla wpisu o "2 lipca br.").
  if (!best.year && d.getTime() < now.getTime() - 300 * 86400000) {
    d = new Date(year + 1, best.month, best.day);
  }
  return d;
}

module.exports = { extractPolishDate };
