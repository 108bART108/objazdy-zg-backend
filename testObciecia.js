// Test pilnujacy, ze zadna tresc nie znika po cichu.
// Uruchomienie:  node testObciecia.js
//
// POWOD POWSTANIA (14.11.2026): komunikat Enei o wylaczeniu pradu to lista
// ulic - kazda pozycja to czyjs dom. enea.js przycinal kazdy opis do 400
// znakow: twardo, w polowie slowa, bez wielokropka i bez sladu w logach.
// Ucieta lista nie wyglada na bledna, tylko na krotsza, wiec nikt tego nie
// zauwaza. A ucinalo akurat najwieksze awarie, bo to one maja najdluzsze
// listy. Dokladnie to samo .slice(0, 400) siedzialo w zwik.js, zdw.js,
// umZgora.js i htmlSources.js.
//
// Gorzej: obciete opisy trafialy do odsiewacza duplikatow, ktory porownuje
// tytul i tresc. Wpisy Enei maja identyczny tytul ("Obszar Zielona Gora")
// i ten sam poczatek, wiec dwa rozne wylaczenia roznice sie dopiero za
// 400. znakiem stawaly sie identyczne - i jedno znikalo z appki w calosci.
//
// Test sprawdza trzy rzeczy:
//   1. zadne zrodlo nie przycina tresci wlasnym, mniejszym limitem,
//   2. limity sanitize.js dzialaja i KAZDE przyciecie zostawia slad,
//   3. w kodzie nie przybyl nowy, nieopisany limit dlugosci.

const fs = require('fs');
const path = require('path');
const { sanitizeItems, limitOpisu, LIMIT_ZRODLA } = require('./sanitize');

// --- 1. kontrakt scraperow --------------------------------------------------
// Kazdy scraper moze zabezpieczyc sie przed zepsuta strona, ale wylacznie
// wspolna stala LIMIT_ZRODLA. Wlasna liczba w tym miejscu = cichy ubytek.
const SCRAPERY = ['enea.js', 'zwik.js', 'zdw.js', 'umZgora.js', 'mzk.js', 'htmlSources.js'];

// --- 3. znane, swiadome skrocenia -------------------------------------------
// Kazda liczba ponizej LIMIT_ZRODLA uzyta w .slice(0, N) musi byc tu opisana.
// Jesli test zglosi cos nowego, to znaczy, ze ktos (czesto ja) dopisal
// kolejne ciche obciecie - albo trzeba je usunac, albo dopisac tutaj powod.
const DOZWOLONE = {
  'ciekawostka.js': { 200: 'skrot bledu API w logu', 500: 'ciekawostka ma byc krotka - to limit tresci, nie opisu utrudnienia' },
  'enea.js': { 10: 'skrot hasha md5' },
  'zdw.js': { 10: 'skrot hasha md5' },
  'healthcheck.js': { 180: 'tresc powiadomienia push' },
  'systemAlerts.js': { 180: 'tresc powiadomienia push' },
  'mzk.js': { 600: 'podglad poczatku HTML przy wykrywaniu pustej strony', 200: 'skrot tresci w logu', 70: 'skrot opisu w logu' },
  'push.js': { 120: 'tresc powiadomienia push', 3: 'liczba ulic w powiadomieniu push', 40: 'skrot adresu w logu' },
  'qualityCheck.js': { 150: 'poczatek opisu do wykrywania boilerplate' },
  'sanitize.js': { 60: 'poczatek opisu do kontroli ucietego startu', 40: 'skrot w tresci ostrzezenia', 80: 'skrot adresu w ostrzezeniu' },
  'server.js': { 20: 'liczba kategorii w subskrypcji push' },
  // Nie dotyczy tresci zapisywanej do bazy - to poczatek tekstu uzywany
  // do DECYZJI (czy wpuscic artykul i do ktorej zakladki). Pelna tresc
  // idzie do appki osobno i nie jest przez to w zaden sposob skracana.
  'umZgora.js': { 400: 'poczatek tekstu do filtrowania i wyboru kategorii' },
  // Fragment zajawki uzywany do sprawdzenia, czy tresc sciagnieta
  // z podstrony pochodzi z tego samego komunikatu.
  'zwik.js': { 40: 'poczatek zajawki do kontroli zgodnosci z podstrona' },
};

function skanujKod() {
  const bledy = [];
  const katalog = __dirname;

  for (const plik of fs.readdirSync(katalog)) {
    if (!plik.endsWith('.js') || plik.startsWith('test')) continue;

    const tresc = fs.readFileSync(path.join(katalog, plik), 'utf8').split('\n');
    tresc.forEach((linia, idx) => {
      const bezKomentarza = linia.replace(/^\s*(\/\/|\*).*$/, '');
      for (const m of bezKomentarza.matchAll(/\.slice\(0,\s*(\d+)\)/g)) {
        const n = Number(m[1]);
        if (n >= LIMIT_ZRODLA) continue;
        if (DOZWOLONE[plik] && DOZWOLONE[plik][n]) continue;
        bledy.push(
          `${plik}:${idx + 1} - nowe obciecie .slice(0, ${n}): "${linia.trim().slice(0, 70)}". `
          + 'Jesli to swiadome i nie dotyczy tresci komunikatu, dopisz powod do listy DOZWOLONE w testObciecia.js',
        );
      }
    });
  }

  for (const plik of SCRAPERY) {
    const sciezka = path.join(katalog, plik);
    if (!fs.existsSync(sciezka)) {
      bledy.push(`brak pliku scrapera ${plik}`);
      continue;
    }
    if (!fs.readFileSync(sciezka, 'utf8').includes('LIMIT_ZRODLA')) {
      bledy.push(`${plik} nie korzysta ze wspolnej stalej LIMIT_ZRODLA - moze przycinac tresc po swojemu`);
    }
  }

  return bledy;
}

// --- 2. zachowanie limitow --------------------------------------------------

function opisDlugosci(dlugosc, prefiks = 'Przerwa w dostawie wody obejmuje ulice: ') {
  const ulice = [];
  let i = 1;
  while ((prefiks + ulice.join(', ')).length < dlugosc) {
    ulice.push(`Kwiatowa ${i}`);
    i += 1;
  }
  return prefiks + ulice.join(', ');
}

function przepusc(category, description) {
  const { items, warnings } = sanitizeItems([{
    source_url: 'https://przyklad.pl/1',
    source_name: 'test',
    category,
    title: 'Obszar Zielona Góra',
    description,
  }]);
  const problemy = warnings.length ? warnings[0].problems : [];
  return {
    opis: items[0] ? items[0].description : '',
    przycieto: problemy.some((p) => p.includes('PRZYCIETY')),
  };
}

function sprawdzLimity() {
  const bledy = [];

  // Kategorie listowe musza miesc dluga liste w calosci.
  for (const kategoria of ['prad', 'wodociagi', 'mzk']) {
    const limit = limitOpisu(kategoria);
    if (limit < 2000) {
      bledy.push(`kategoria "${kategoria}" ma limit ${limit} - listy adresow/linii wymagaja co najmniej 2000`);
    }

    const dlugi = opisDlugosci(limit - 100);
    const wynik = przepusc(kategoria, dlugi);
    if (wynik.opis.length !== dlugi.length) {
      bledy.push(`kategoria "${kategoria}": opis ${dlugi.length} zn. zostal skrocony do ${wynik.opis.length}, a miesci sie w limicie ${limit}`);
    }
    if (wynik.przycieto) {
      bledy.push(`kategoria "${kategoria}": zgloszono przyciecie, choc opis miescil sie w limicie`);
    }
  }

  // Przekroczenie limitu MUSI zostawic slad - inaczej wracamy do punktu wyjscia.
  for (const kategoria of ['prad', 'wodociagi', 'mzk', 'drogi']) {
    const limit = limitOpisu(kategoria);
    const zaDlugi = opisDlugosci(limit + 500);
    const wynik = przepusc(kategoria, zaDlugi);
    if (!wynik.przycieto) {
      bledy.push(`kategoria "${kategoria}": opis ${zaDlugi.length} zn. zostal przyciety do ${wynik.opis.length} BEZ ostrzezenia`);
    }
    if (wynik.opis.length > limit) {
      bledy.push(`kategoria "${kategoria}": opis po przycieciu ma ${wynik.opis.length} zn., wiecej niz limit ${limit}`);
    }
  }

  // Prawdziwy komunikat Enei ze zrzutu uzytkownika - ma przejsc bez zmian.
  const enea = '20 listopada 2026 r. w godz. 08:30 - 12:30 miejscowości Zielona Góra: '
    + 'ulice Łużycka 18, od 22 do 22D, działka 164/25, punkt usługowy R2/803/JN/2002, '
    + 'tablica informacyjna przystanek 225, Sucharskiego 16, 17, 18, działka 164/23';
  const wynikEnea = przepusc('prad', enea);
  if (wynikEnea.opis !== enea) {
    bledy.push(`prawdziwy komunikat Enei zostal zmieniony: "${wynikEnea.opis.slice(-60)}"`);
  }

  return bledy;
}

// --- 4. tresc nie moze byc przeinaczana --------------------------------------
// qualityCheck rozdziela sklejone slowa ("brak wodyPrzerwa" -> "brak wody
// Przerwa"). Robil to na kazdej granicy mala/wielka litera, wiec rozrywal
// tez skroty z wielka litera w srodku - "ZWiK" zamienial sie w "ZWi K"
// w niemal kazdym komunikacie wodociagow.
const SKLEJKI = [
  ['ZWiK informuje, że nastąpi przerwa.', 'ZWiK informuje, że nastąpi przerwa.'],
  ['Spółka ZWiK Zielona Góra.', 'Spółka ZWiK Zielona Góra.'],
  ['brak wodyPrzerwa w dostawie', 'brak wody Przerwa w dostawie'],
  ['odpowiedzialnościąul. Chemiczna', 'odpowiedzialnością ul. Chemiczna'],
];

function sprawdzSklejki() {
  const bledy = [];
  const src = fs.readFileSync(path.join(__dirname, 'qualityCheck.js'), 'utf8');
  const kod = src.match(/function fixGluedText[\s\S]*?\n}/);
  if (!kod) {
    bledy.push('nie znaleziono funkcji fixGluedText w qualityCheck.js');
    return bledy;
  }
  // eslint-disable-next-line no-eval
  const fixGluedText = eval(`(${kod[0].replace('function fixGluedText', 'function')})`);

  for (const [wejscie, oczekiwane] of SKLEJKI) {
    const wynik = fixGluedText(wejscie);
    if (wynik !== oczekiwane) {
      bledy.push(`sklejki: "${wejscie}" -> "${wynik}", oczekiwano "${oczekiwane}"`);
    }
  }
  return bledy;
}

/**
 * Uruchamia wszystkie kontrole. Zwraca { sprawdzonych, bledy }.
 * Nie wypisuje niczego i nie konczy procesu - wola ja takze startupCheck.js.
 */
function uruchomTesty() {
  const bledy = [...skanujKod(), ...sprawdzLimity(), ...sprawdzSklejki()];
  // 6 scraperow + 3 kategorie listowe + 4 kategorie przy przekroczeniu
  // + 1 prawdziwy komunikat Enei + 4 sklejki
  return { sprawdzonych: 18, bledy };
}

if (require.main === module) {
  const { sprawdzonych, bledy } = uruchomTesty();
  for (const b of bledy) console.log(`BLAD ${b}`);
  console.log(`\nSprawdzono ${sprawdzonych} regul obciec, bledow: ${bledy.length}`);
  process.exit(bledy.length ? 1 : 0);
}

module.exports = { uruchomTesty };
