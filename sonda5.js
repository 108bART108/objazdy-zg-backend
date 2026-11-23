// Sonda nr 5 - szukanie kanalow RSS u wodociagow z gmin sasiadujacych
// z Zielona Gora. TYLKO DO CZYTANIA: nic nie zapisuje, nie dotyka bazy,
// nie zmienia zadnego pliku. Mozna bezpiecznie uruchomic na produkcji:
//     node sonda5.js
//
// PO CO: siedem gmin graniczy z Zielona Gora i w kazdej ktos inny odpowiada
// za wode. Czesc tych stron stoi na WordPressie, jedna na Joomli, trzy na
// wspolnym CMS-ie gminnym. Jesli ktorakolwiek wystawia kanal RSS, to jest to
// zrodlo o klase lepsze od scrapowania HTML-a: nie psuje sie przy zmianie
// wygladu strony, ma daty i nie wymaga odgadywania, gdzie konczy sie tresc.
//
// JAK: najpierw pobieramy strone z ogloszeniami i czytamy z jej naglowka
// <link rel="alternate" type="application/rss+xml">. To jest wlasciwy sposob:
// strona SAMA mowi, gdzie ma kanal, zamiast zgadywania adresow. Dopiero potem
// dokladamy kilka typowych adresow charakterystycznych dla WordPressa i Joomli.
//
// UWAGA: supekom.pl i otyn.pl przekierowuja z HTTPS na HTTP, czego moje
// narzedzie do przegladania stron nie potrafilo przejsc. Node podaza za
// przekierowaniem normalnie, wiec stad to zadziala.
//
// Wynik wklej w rozmowie.

const cheerio = require('cheerio');
const Parser = require('rss-parser');

// Tak samo przedstawia sie dzialajacy scraper PZZD - ta nazwa przechodzi
// przez zapory BIP-ow. Slowa "bot" w nazwie unikamy swiadomie.
const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'Accept': 'text/html,application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const LIMIT_CZASU_MS = 20000;
const PAUZA_MS = 400;          // male serwery gminne - pobieramy spokojnie
const DL_TYTULU = 90;
const DL_FRAGMENTU = 200;
const ILE_WPISOW = 4;          // ile pierwszych wpisow kanalu pokazac
const ILE_TROPOW = 6;          // ile znalezionych linkow "awaryjnych" pokazac

const CELE = [
  {
    gmina: 'Sulechów',
    kto: 'SuPeKom - Sulechowskie Przedsiębiorstwo Komunalne',
    strona: 'http://www.supekom.pl/kategoria/przerwy-w-dostawie-wody/',
    kandydaci: [
      'http://www.supekom.pl/kategoria/przerwy-w-dostawie-wody/feed/',
      'http://www.supekom.pl/kategoria/komunikaty/feed/',
      'http://www.supekom.pl/feed/',
    ],
  },
  {
    gmina: 'Nowogród Bobrzański',
    kto: 'Spółka Wodno-Ściekowa Miasta i Gminy Nowogród Bobrzański',
    strona: 'https://spwsnow.pl/?cat=5',
    // Ta strona ma adresy w postaci ?p=123, czyli bez "ladnych" odnosnikow -
    // wtedy w WordPressie dziala forma ?feed=rss2, a nie /feed/.
    kandydaci: [
      'https://spwsnow.pl/?feed=rss2&cat=5',
      'https://spwsnow.pl/?feed=rss2',
      'https://spwsnow.pl/feed/',
    ],
  },
  {
    gmina: 'Kożuchów',
    kto: 'USKOM - Usługi Komunalne',
    strona: 'https://uskom.eu/',
    kandydaci: [
      'https://uskom.eu/feed/',
      'https://uskom.eu/?feed=rss2',
    ],
  },
  {
    gmina: 'Czerwieńsk',
    kto: 'POMAK - Przedsiębiorstwo Obsługi Mienia Komunalnego',
    strona: 'https://www.pomak.pl/',
    // Joomla ma wbudowany kanal pod ?format=feed
    kandydaci: [
      'https://www.pomak.pl/?format=feed&type=rss',
      'https://www.pomak.pl/index.php?format=feed&type=rss',
    ],
  },
  {
    gmina: 'Świdnica',
    kto: 'Zakład Usług Komunalnych (gmina Świdnica)',
    strona: 'https://swidnica.zgora.pl/',
    kandydaci: ['https://swidnica.zgora.pl/rss/'],
  },
  {
    gmina: 'Zabór',
    kto: 'gmina Zabór (wodociągi publiczne)',
    strona: 'https://www.gminazabor.pl/',
    kandydaci: ['https://www.gminazabor.pl/rss/'],
  },
  {
    gmina: 'Otyń',
    kto: 'gmina Otyń (operator do potwierdzenia)',
    strona: 'http://www.otyn.pl/PL/1000/1/archiwum/News_box/',
    kandydaci: ['http://www.otyn.pl/rss/'],
  },
];

// Slowa, po ktorych poznajemy, ze strona faktycznie pisze o wodzie.
const SLOWA = /awari|przerw\w*\s+w\s+dostaw|brak\w*\s+wody|bez\s+wody|wodoci[ąa]g|wyl[ąa]czeni|uzdatnian/i;

function skroc(tekst, ile) {
  const t = String(tekst || '').replace(/\s+/g, ' ').trim();
  return t.length > ile ? `${t.substring(0, ile)}…` : t;
}

function odczekaj(ms) {
  return new Promise((res) => setTimeout(res, ms));
}

async function pobierz(url) {
  const kontroler = new AbortController();
  const stoper = setTimeout(() => kontroler.abort(), LIMIT_CZASU_MS);
  try {
    const odp = await fetch(url, { headers: NAGLOWKI, redirect: 'follow', signal: kontroler.signal });
    const tekst = await odp.text();
    return {
      ok: odp.ok,
      status: odp.status,
      typ: odp.headers.get('content-type') || '(brak)',
      koncowyUrl: odp.url !== url ? odp.url : null,
      tekst,
    };
  } finally {
    clearTimeout(stoper);
  }
}

// Czy to, co przyszlo, naprawde jest kanalem - i ile ma wpisow.
async function sprawdzKanal(url) {
  let wynik;
  try {
    wynik = await pobierz(url);
  } catch (err) {
    return { url, stan: `blad pobierania: ${err.message}` };
  }

  if (!wynik.ok) return { url, stan: `HTTP ${wynik.status}` };

  const wygladaNaXml = /^\s*(<\?xml|<rss|<feed)/i.test(wynik.tekst);
  if (!wygladaNaXml) {
    // Czesty przypadek: serwer oddaje zwykla strone HTML zamiast 404.
    return { url, stan: `HTTP ${wynik.status}, ale to nie kanal (${wynik.typ})` };
  }

  try {
    const kanal = await new Parser().parseString(wynik.tekst);
    return {
      url,
      stan: 'DZIAŁA',
      tytulKanalu: kanal.title || '(bez tytulu)',
      wpisow: (kanal.items || []).length,
      wpisy: (kanal.items || []).slice(0, ILE_WPISOW).map((i) => ({
        tytul: skroc(i.title, DL_TYTULU),
        data: i.isoDate || i.pubDate || '(bez daty)',
        maPelnaTresc: Boolean(i['content:encodedSnippet'] || i.contentSnippet),
      })),
    };
  } catch (err) {
    return { url, stan: `XML sie nie parsuje: ${err.message}` };
  }
}

async function zbadaj(cel) {
  console.log('');
  console.log('==========================================================');
  console.log(`${cel.gmina} — ${cel.kto}`);
  console.log('==========================================================');

  // --- 1. Strona z ogloszeniami: czy zyje i czy sama wskazuje kanal --------
  let strona;
  try {
    strona = await pobierz(cel.strona);
  } catch (err) {
    console.log(`strona ${cel.strona}`);
    console.log(`  BLAD POBIERANIA: ${err.message}`);
    return;
  }

  console.log(`strona: ${cel.strona}`);
  console.log(`  HTTP ${strona.status} | ${strona.typ} | ${strona.tekst.length} zn.`);
  if (strona.koncowyUrl) console.log(`  przekierowano na: ${strona.koncowyUrl}`);

  const znalezione = [];
  if (strona.ok && /html/i.test(strona.typ)) {
    const $ = cheerio.load(strona.tekst);

    // To jest wlasciwa droga: strona sama oglasza swoj kanal w naglowku.
    $('link[rel="alternate"]').each((_, el) => {
      const typ = ($(el).attr('type') || '').toLowerCase();
      const href = $(el).attr('href') || '';
      if (!href) return;
      if (!/rss|atom|xml/.test(typ)) return;
      znalezione.push(new URL(href, strona.koncowyUrl || cel.strona).href);
    });

    const generator = $('meta[name="generator"]').attr('content');
    if (generator) console.log(`  CMS (z metadanych): ${generator}`);

    console.log(znalezione.length
      ? `  strona OGŁASZA kanał: ${znalezione.join(', ')}`
      : '  strona nie ogłasza żadnego kanału w nagłówku');

    // Tropy: odnosniki, ktore wygladaja na komunikat o wodzie.
    const tropy = [];
    $('a[href]').each((_, el) => {
      const tekst = skroc($(el).text(), DL_TYTULU);
      if (tekst && SLOWA.test(tekst)) {
        tropy.push(`${tekst}  ->  ${new URL($(el).attr('href'), strona.koncowyUrl || cel.strona).href}`);
      }
    });
    const bezPowtorzen = [...new Set(tropy)];
    if (bezPowtorzen.length) {
      console.log(`  odnośniki o wodzie (${bezPowtorzen.length}), pierwsze ${ILE_TROPOW}:`);
      bezPowtorzen.slice(0, ILE_TROPOW).forEach((t) => console.log(`     ${t}`));
    } else {
      console.log('  na tej stronie nie widzę odnośników o wodzie');
      const ileWTekscie = (strona.tekst.match(SLOWA) || []).length;
      console.log(`  (słowa o wodzie w samym tekście strony: ${ileWTekscie ? 'są' : 'brak'})`);
    }
  }

  // --- 2. Kanaly: najpierw ogloszone przez strone, potem typowe adresy -----
  const doSprawdzenia = [...new Set([...znalezione, ...cel.kandydaci])];
  console.log('');
  console.log(`  kanały do sprawdzenia: ${doSprawdzenia.length}`);

  for (const url of doSprawdzenia) {
    await odczekaj(PAUZA_MS);
    const w = await sprawdzKanal(url);
    console.log(`  [${w.stan}] ${url}`);
    if (w.stan !== 'DZIAŁA') continue;

    console.log(`      tytuł kanału: ${w.tytulKanalu}`);
    console.log(`      wpisów w kanale: ${w.wpisow}`);
    for (const wp of w.wpisy) {
      console.log(`      - ${wp.data} | ${wp.tytul}`);
      console.log(`        pełna treść w kanale: ${wp.maPelnaTresc ? 'TAK' : 'nie'}`);
    }
  }
}

(async () => {
  console.log('SONDA 5 - kanały RSS wodociągów w gminach sąsiadujących z Zieloną Górą');
  console.log('(tylko czytanie - nic nie jest zapisywane)');
  for (const cel of CELE) {
    await zbadaj(cel);
    await odczekaj(PAUZA_MS);
  }
  console.log('');
  console.log('KONIEC. Sonda nic nie zapisała i nic nie zmieniła.');
})();
