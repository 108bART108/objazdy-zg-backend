// Zrodlo #1: oficjalny RSS Urzedu Miasta Zielona Gora (WordPress).
// WordPress domyslnie wystawia kanal RSS pod adresem /feed/ dla kazdego
// tagu/kategorii/calej strony, wiec to najbardziej stabilne zrodlo -
// nie zalezy od zmian w HTML/CSS strony, jak zwykly scraping.

const Parser = require('rss-parser');
const parser = new Parser();
const { detectCategory, extractStreet } = require('./classify');
const { sendSystemAlert } = require('./systemAlerts');

// DWA RODZAJE KANALOW, celowo:
//
// 1. Kanaly tagowe - wszystko, co redakcja oznaczyla jako drogowe. Tu nie
//    filtrujemy niczego: skoro czlowiek nadal artykulowi tag "drogi w
//    Zielonej Gorze", to wiemy, ze dotyczy on ruchu.
//
// 2. Kanal glowny - WSZYSTKIE artykuly ze strony miasta, przepuszczone
//    przez filtr tresci.
//
// Powod istnienia punktu 2: 2.11.2026 okazalo sie, ze komunikaty "Rusza
// przebudowa zielonogorskiego deptaka" oraz "Zmiany w organizacji ruchu na
// Fabrycznej" nie trafily do appki, bo redakcja opublikowala je wylacznie w
// kategorii "Aktualnosci", bez tagu drogowego. Opieranie sie tylko na tagach
// oznacza, ze o tym, czy mieszkaniec dowie sie o zamknietej ulicy, decyduje
// to, czy ktos w urzedzie pamietal o zaznaczeniu wlasciwego pola. Kanal
// glowny usuwa te zaleznosc.
const FEEDS = [
  { url: 'https://www.zielona-gora.pl/tag/drogi-w-zielonej-gorze/feed/', name: 'UM Zielona Gora', filtruj: false },
  { url: 'https://www.zielona-gora.pl/tag/ofensywa-drogowa/feed/', name: 'UM Zielona Gora', filtruj: false },
  { url: 'https://www.zielona-gora.pl/feed/', name: 'UM Zielona Gora', filtruj: true },
];

// Sygnaly, ze artykul dotyczy utrudnien w miescie.
//
// Wzorce sa celowo WASKIE i wielowyrazowe. Samo slowo "ruch" bylo by
// pulapka: artykul o Swiecie Niepodleglosci zachecajacy do "ruchu na
// swiezym powietrzu" trafilby wtedy do appki o utrudnieniach. Dlatego
// szukamy "organizacji ruchu", "sterowania ruchem" czy "ograniczen w
// ruchu" - a nie samego rdzenia.
const WZORZEC_UTRUDNIENIA = new RegExp([
  // organizacja i ograniczenia ruchu
  'organizacj\\w* ruchu', 'sterowani\\w* ruchem', 'ograniczeni\\w* w ruchu',
  'ruch\\w* drogow', 'wy[łl][ąa]czon\\w* z ruchu', 'nieprzejezdn',
  // roboty i ich skutki
  'przebudow', 'remont', 'modernizacj\\w* (ulic|drog|skrzy[żz]|most)',
  'roboty drogowe', 'prace drogowe', 'prace budowlane',
  'objazd', 'zamkni[ęe]ci\\w* (ulic|drog|przejazd|skrzy[żz]|parking)',
  'zw[ęe][żz]eni', 'utrudnieni',
  // infrastruktura drogowa
  'skrzy[żz]owani', 'rondo', 'sygnalizacj\\w* [śs]wietln', 'przejazd kolejow',
  // bezposrednie zwroty do kierowcow i pieszych
  'kierowcy musz', 'kierowcy, uwaga', 'dla kierowc[óo]w', 'piesi musz',
  // awarie i przerwy
  'awari', 'przerw\\w* w dostawie', 'brak wody', 'wy[łl][ąa]czeni\\w* pr[ąa]du',
].join('|'), 'i');

function dotyczyUtrudnienia(tytul, opis) {
  return WZORZEC_UTRUDNIENIA.test(`${tytul} ${opis || ''}`);
}

// Kanal glowny jest jedynym, ktory wychwytuje artykuly bez tagu drogowego.
// Gdyby przestal dzialac, kanaly tagowe nadal zwracalyby wpisy - czyli
// zrodlo "umZgora" wygladaloby na zdrowe, a appka po cichu przestalaby
// pokazywac czesc komunikatow. Dokladnie tak wygladal blad, przez ktory
// powstal ten kanal, wiec pilnujemy go osobno.
const PORAZKI_PRZED_ALERTEM = 8;
let kolejnePorazkiKanaluGlownego = 0;
let zgloszonoAwarieKanalu = false;

function odnotujWynikKanaluGlownego(udany) {
  if (udany) {
    if (zgloszonoAwarieKanalu) console.log('[umZgora] kanal glowny znowu dziala');
    kolejnePorazkiKanaluGlownego = 0;
    zgloszonoAwarieKanalu = false;
    return;
  }
  kolejnePorazkiKanaluGlownego++;
  if (kolejnePorazkiKanaluGlownego >= PORAZKI_PRZED_ALERTEM && !zgloszonoAwarieKanalu) {
    zgloszonoAwarieKanalu = true;
    console.error(`[umZgora] kanal glowny nie dziala od ${kolejnePorazkiKanaluGlownego} cykli - komunikaty bez tagu drogowego nie trafiaja do appki`);
    sendSystemAlert(
      'Kanal glowny strony miasta nie dziala',
      `Od ${kolejnePorazkiKanaluGlownego} cykli nie udaje sie pobrac glownego kanalu zielona-gora.pl. Komunikaty bez tagu drogowego moga nie trafiac do appki.`
    ).catch(() => { /* alert jest dodatkiem, nie moze przerwac scrapowania */ });
  }
}

async function fetchUmZgora() {
  const results = [];
  const widzianeAdresy = new Set();
  let pominietych = 0;

  for (const feed of FEEDS) {
    try {
      const parsed = await parser.parseURL(feed.url);
      for (const item of parsed.items) {
        // Ten sam artykul bywa w kanale tagowym i glownym - bierzemy raz.
        if (!item.link || widzianeAdresy.has(item.link)) continue;

        const opis = (item.contentSnippet || '').slice(0, 400);

        // Kanal glowny zawiera cale zycie miasta: forum senioralne, koncerty,
        // swieta. Do appki o utrudnieniach wpuszczamy tylko to, co faktycznie
        // dotyczy ruchu, awarii lub przerw w dostawach.
        if (feed.filtruj && !dotyczyUtrudnienia(item.title, opis)) {
          pominietych++;
          continue;
        }

        widzianeAdresy.add(item.link);
        const text = `${item.title} ${item.contentSnippet || ''}`;
        results.push({
          source_url: item.link,
          source_name: feed.name,
          category: detectCategory(text),
          title: item.title,
          street: extractStreet(item.title),
          description: opis,
          published_at: item.isoDate || item.pubDate || new Date().toISOString(),
        });
      }
      if (feed.filtruj) odnotujWynikKanaluGlownego(true);
    } catch (err) {
      console.error(`[umZgora] blad pobierania ${feed.url}:`, err.message);
      if (feed.filtruj) odnotujWynikKanaluGlownego(false);
    }
  }

  if (pominietych) {
    console.log(`[umZgora] z kanalu glownego pominieto ${pominietych} artykulow niezwiazanych z utrudnieniami`);
  }
  return results;
}

module.exports = { fetchUmZgora, dotyczyUtrudnienia };
