const MZK_WORDS = ['mzk', 'autobus', 'linii nr', 'linia nr', 'przystan', 'trolejbus', 'tramwaj', 'rozkład jazdy'];
const WODOCIAGI_WORDS = ['wodoci', 'awaria sieci wodociągowej', 'awaria sieci wodoc', 'awaria wody', 'brak wody', 'kanalizacj', 'zwik'];
const PRAD_WORDS = ['wyłączeni', 'przerwa w dostawie prądu', 'brak prądu', 'bez prądu', 'awaria energ', 'awaria sieci elektryczn', 'enea operator', 'energii elektrycznej'];

function detectCategory(text) {
  const lower = text.toLowerCase();
  if (MZK_WORDS.some((w) => lower.includes(w))) return 'mzk';
  if (WODOCIAGI_WORDS.some((w) => lower.includes(w))) return 'wodociagi';
  if (PRAD_WORDS.some((w) => lower.includes(w))) return 'prad';
  return 'drogi';
}

// Wyciaga prawdopodobna nazwe ulicy z tytulu, np. "ul. Waryńskiego", "Sulechowska"
function extractStreet(title) {
  const streetMatch = title.match(/ul\.\s?[A-ZŻŹĆĄŚĘŁÓŃ][\wżźćąśęłóńĄŚĘŁÓŃŻŹĆ.\- ]{2,30}/);
  if (streetMatch) return streetMatch[0].trim().replace(/[.,;:]+$/, '');
  return null;
}

module.exports = { detectCategory, extractStreet };
