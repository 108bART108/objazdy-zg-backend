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
 * Znajduje PIERWSZA pelna polska date (dzien + nazwa miesiaca, opcjonalnie
 * rok) w dowolnym tekscie. Przy wielu datach w tekscie (np. zakres
 * "od 31 sierpnia do 4 wrzesnia") bierze pierwsza - zazwyczaj to data
 * rozpoczecia, najbardziej przydatna dla plakietki "za X dni".
 *
 * @param {string} text
 * @param {Date} now - do rozstrzygania roku, gdy nie jest podany w tekscie
 * @returns {Date|null}
 */
function extractPolishDate(text, now = new Date()) {
  if (!text) return null;
  const re = new RegExp(`(\\d{1,2})\\s+(${MONTH_NAMES_RE})(?:\\s+(\\d{4}))?`, 'giu');
  const match = re.exec(text);
  if (!match) return null;

  const day = Number(match[1]);
  const month = MONTHS[match[2].toLowerCase()];
  let year = match[3] ? Number(match[3]) : now.getFullYear();
  let d = new Date(year, month, day);
  if (isNaN(d.getTime())) return null;

  // Brak roku w tekscie i data wypadlaby ponad 60 dni w przeszlosci ->
  // to prawie na pewno chodzi o przyszly rok (np. "3 stycznia"
  // wspomniane w grudniu).
  if (!match[3] && d.getTime() < now.getTime() - 60 * 86400000) {
    d = new Date(year + 1, month, day);
  }
  return d;
}

module.exports = { extractPolishDate };
