// Sonda nr 13 - co zniknie z appki po wlaczeniu wygasania. TYLKO DO CZYTANIA.
//     node sonda13.js
//
// Wygasanie wpisow jest zmiana, ktorej skutku NIE WIDAC w testach. Testy
// mowia, ze regula dziala na przypadkach, ktore wymyslilem. Nie mowia,
// ile i KTORE z Twoich siedemdziesieciu wpisow znikna z appki w dniu
// wdrozenia. To trzeba zobaczyc przed, a nie po.
//
// Sonda otwiera prawdziwa baze W TRYBIE TYLKO DO ODCZYTU i wypisuje, ktore
// wpisy przestalyby byc widoczne i z jakiego powodu. Nie zapisuje niczego,
// nie zmienia zadnego wiersza i nie dotyka pliku bazy inaczej niz czytajac.
//
// UWAGA przy czytaniu wyniku: kolumna last_seen jeszcze nie istnieje, bo
// migracja przyjdzie razem z wdrozeniem. Sonda policzy wiec wylacznie
// REGULE WIEKU - a to i tak jest ta regula, ktora zdejmuje najwiecej
// i ktora najlatwiej przesadzic. Regula nieobecnosci zacznie dzialac dobe
// po wdrozeniu i dotknie tylko wpisow, ktorych zrodla naprawde przestaly
// wymieniac.

const path = require('path');
const Database = require('better-sqlite3');
const { powodUkrycia, WIDOCZNOSC } = require('./widocznosc');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'objazdy.db');
const DL_TYTULU = 95;

function skroc(t, ile) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > ile ? `${s.substring(0, ile)}…` : s;
}

function dzien(iso) {
  if (!iso) return '(brak)';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '(zla data)' : d.toISOString().substring(0, 10);
}

console.log('SONDA 13 — co zniknie z appki po wlaczeniu wygasania');
console.log(`baza: ${DB_PATH} (otwarta tylko do odczytu)`);
console.log('');

console.log('=== PROGI ===');
Object.entries(WIDOCZNOSC).forEach(([nazwa, p]) => {
  console.log(`  ${nazwa.padEnd(10)} nieobecnosc u zrodla: ${String(p.nieobecnoscDni).padStart(3)} dni `
    + `| skrajny wiek: ${String(p.wiekDni).padStart(3)} dni`);
});

let db;
try {
  db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
} catch (err) {
  console.log('');
  console.log(`Nie udalo sie otworzyc bazy: ${err.message}`);
  console.log('Jesli to "unable to open database file", uruchom sonde z katalogu /app.');
  process.exit(1);
}

const wiersze = db.prepare(
  'SELECT * FROM utrudnienia WHERE active = 1 AND needs_review = 0 ORDER BY category, published_at DESC',
).all();

console.log('');
console.log(`=== WPISY WIDOCZNE DZIS W APPCE: ${wiersze.length} ===`);

const wgKategorii = {};
const znikna = [];

for (const w of wiersze) {
  wgKategorii[w.category] = wgKategorii[w.category] || { razem: 0, znika: 0 };
  wgKategorii[w.category].razem += 1;

  const powod = powodUkrycia(w);
  if (powod) {
    wgKategorii[w.category].znika += 1;
    znikna.push({ w, powod });
  }
}

Object.entries(wgKategorii).forEach(([kat, s]) => {
  const zostaje = s.razem - s.znika;
  console.log(`  ${kat.padEnd(10)} ${String(s.razem).padStart(3)} wpisow  →  zostaje ${String(zostaje).padStart(3)}, znika ${s.znika}`);
});

console.log('');
console.log(`=== ZNIKNIE: ${znikna.length} z ${wiersze.length} ===`);
if (!znikna.length) {
  console.log('  Nic. Zadnego wpisu nie trzeba dzis chowac.');
} else {
  for (const { w, powod } of znikna) {
    console.log('');
    console.log(`  [${w.category}] ${skroc(w.title, DL_TYTULU)}`);
    console.log(`      zrodlo:     ${w.source_name}`);
    console.log(`      publikacja: ${dzien(w.published_at)} | zdarzenie: ${dzien(w.event_date)}`);
    console.log(`      POWOD:      ${powod}`);
  }
}

// Najstarsze wpisy, ktore MIMO WSZYSTKO zostaja - tu widac, czy progi nie
// sa za lagodne. Jesli w tej tabelce stoi cos sprzed roku, prog jest zly.
const zostajace = wiersze.filter((w) => !powodUkrycia(w));
const najstarsze = zostajace
  .filter((w) => w.published_at)
  .sort((a, b) => Date.parse(a.published_at) - Date.parse(b.published_at));

console.log('');
console.log('=== NAJSTARSZE WPISY, KTORE ZOSTAJA ===');
console.log('(jesli cos tu wyglada na dawno nieaktualne, prog jest za lagodny)');
const ILE_NAJSTARSZYCH = 8;
najstarsze.slice(0, ILE_NAJSTARSZYCH).forEach((w) => {
  const dni = Math.floor((Date.now() - Date.parse(w.published_at)) / 86400000);
  console.log(`  ${dzien(w.published_at)} (${dni} dni) [${w.category}] ${skroc(w.title, DL_TYTULU)}`);
});

db.close();
console.log('');
console.log('KONIEC. Sonda nic nie zapisala i nic nie zmienila.');
