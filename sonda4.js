// Sonda nr 4 - TYLKO DO PODGLADU. Nic nie zapisuje, nic nie importuje,
// nie dotyka bazy ani plikow. Mozna bezpiecznie uruchomic na produkcji:
//     node sonda4.js
//
// PO CO: dwa komunikaty PZZD zostaly 22.11.2026 oznaczone do przejrzenia z
// powodem "opis urywa sie na dwukropku - prawdopodobnie brakuje dalszej
// czesci (np. listy)". To ten sam objaw, ktory w MZK trzymal przez miesiac
// uciety komunikat o ul. Zacisze: po dwukropku na stronie stoi lista, ktorej
// parser nie zbiera. Zeby poprawic to raz, a nie zgadywac, musze zobaczyc
// surowy uklad HTML tych dwoch podstron.
//
// Wynik wklej w rozmowie. Jesli jest dlugi, wystarczy czesc od "=== UKLAD".

const CELE = [
  {
    nazwa: 'Tour De Pologne (opis 1203 zn., urywa sie na dwukropku)',
    url: 'https://bip.pzzd.powiat-zielonogorski.pl/510/05_08_2026_Tour_De_Pologne/',
  },
  {
    nazwa: 'Most na Kanale Dychowskim (opis 366 zn., urywa sie na dwukropku)',
    url: 'https://bip.pzzd.powiat-zielonogorski.pl/311/1_2023_Utrudnienia_w_ruchu_drogowym_-_most_na_Kanale_Dychowskim_-_przed_m__Lagoda/',
  },
];

// Tak samo przedstawia sie dzialajacy scraper - BIP przyjmuje wlasnie te nazwe.
const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'Accept': 'text/html,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const LIMIT_CZASU_MS = 20000;
const DL_UKLADU = 6000;      // ile znakow surowego HTML obszaru tresci pokazac
const DL_LINII = 200;        // ile znakow jednej linii tekstu pokazac
const MAX_LINII = 40;        // ile linii tekstu wypisac

function obetnij(tekst, ile) {
  const t = String(tekst || '');
  return t.length > ile ? `${t.substring(0, ile)}\n…[uciete, calosc ma ${t.length} zn.]` : t;
}

async function zbadaj(cel) {
  console.log('');
  console.log('==========================================================');
  console.log(`CEL: ${cel.nazwa}`);
  console.log(cel.url);
  console.log('==========================================================');

  const kontroler = new AbortController();
  const stoper = setTimeout(() => kontroler.abort(), LIMIT_CZASU_MS);

  let html;
  try {
    const odp = await fetch(cel.url, { headers: NAGLOWKI, redirect: 'follow', signal: kontroler.signal });
    console.log(`HTTP ${odp.status} | ${odp.headers.get('content-type') || 'brak typu'}`);
    if (!odp.ok) {
      console.log('(nie pobrano - dalej nie ma czego pokazywac)');
      return;
    }
    html = await odp.text();
  } catch (err) {
    console.log(`BLAD POBIERANIA: ${err.message}`);
    return;
  } finally {
    clearTimeout(stoper);
  }

  console.log(`dlugosc calej strony: ${html.length} zn.`);

  // Wycinamy obszar tresci - ten sam, z ktorego czyta parser (.paragraph).
  const start = html.indexOf('class="paragraph"');
  if (start === -1) {
    console.log('');
    console.log('!!! NIE MA elementu class="paragraph" - uklad tej podstrony jest INNY');
    console.log('    niz pozostalych. To samo w sobie jest odpowiedzia.');
    const infoStart = html.indexOf('class="information"');
    if (infoStart !== -1) {
      console.log('');
      console.log('=== UKLAD (obszar class="information") ===');
      console.log(obetnij(html.substring(infoStart), DL_UKLADU));
    }
    return;
  }

  const koniec = html.indexOf('class="print"', start);
  const obszar = html.substring(start, koniec === -1 ? html.length : koniec);

  console.log('');
  console.log('=== UKLAD (surowy HTML obszaru tresci) ===');
  console.log(obetnij(obszar, DL_UKLADU));

  // Co stoi PO dwukropku - to jest sedno sprawy.
  console.log('');
  console.log('=== CO STOI PO DWUKROPKU ===');
  const znaczniki = obszar.match(/<(table|tbody|tr|td|th|ol|ul|li|p|div|span|br)\b[^>]*>/gi) || [];
  const policz = {};
  for (const z of znaczniki) {
    const nazwa = z.replace(/^<([a-z]+)\b.*$/i, '$1').toLowerCase();
    policz[nazwa] = (policz[nazwa] || 0) + 1;
  }
  console.log(`uzyte znaczniki: ${Object.entries(policz).map(([k, v]) => `${k}=${v}`).join(', ')}`);

  // Tekst bez znacznikow, linia po linii - widac, gdzie tekst sie urywa.
  console.log('');
  console.log('=== TEKST (po usunieciu znacznikow) ===');
  const tekst = obszar
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h\d)>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&oacute;/g, 'o')
    .replace(/&ndash;/g, '-')
    .replace(/&amp;/g, '&');

  const linie = tekst.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  linie.slice(0, MAX_LINII).forEach((l, i) => {
    const gwiazdka = /:$/.test(l) ? '  <<< KONCZY SIE DWUKROPKIEM' : '';
    console.log(`${String(i + 1).padStart(2)}. ${obetnij(l, DL_LINII)}${gwiazdka}`);
  });
  if (linie.length > MAX_LINII) console.log(`… i jeszcze ${linie.length - MAX_LINII} linii`);
}

(async () => {
  console.log('SONDA 4 - podglad ukladu dwoch podstron PZZD (tylko czytanie)');
  for (const cel of CELE) {
    await zbadaj(cel);
  }
  console.log('');
  console.log('KONIEC. Sonda nic nie zapisala i nic nie zmienila.');
})();
