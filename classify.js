const MZK_WORDS = ['mzk', 'autobus', 'linii nr', 'linia nr', 'przystan', 'komunikacj'];
const WODOCIAGI_WORDS = ['wodoci', 'awaria sieci', 'kanalizacj', 'zwik'];

function detectCategory(text) {
  const lower = text.toLowerCase();
  if (MZK_WORDS.some((w) => lower.includes(w))) return 'mzk';
  if (WODOCIAGI_WORDS.some((w) => lower.includes(w))) return 'wodociagi';
  return 'drogi';
}

// Wyciaga prawdopodobna nazwe ulicy z tytulu, np. "ul. Waryńskiego", "Sulechowska"
function extractStreet(title) {
  const streetMatch = title.match(/ul\.\s?[A-ZŻŹĆĄŚĘŁÓŃ][\wżźćąśęłóńĄŚĘŁÓŃŻŹĆ.\- ]{2,30}/);
  if (streetMatch) return streetMatch[0].trim().replace(/[.,;:]+$/, '');
  return null;
}

module.exports = { detectCategory, extractStreet };
