// Wodociagi w gminach sasiadujacych z Zielona Gora.
//
// Na razie dwie gminy, obie czytane z kanalu RSS - czyli bez scrapowania
// HTML-a, ktore psuje sie przy kazdej zmianie wygladu strony:
//
//   Czerwiensk          - POMAK (Joomla, kanal z pelna trescia)
//   Nowogrod Bobrzanski - Spolka Wodno-Sciekowa (WordPress)
//
// SKAD WIEMY, ZE TE KANALY DZIALAJA: sonda uruchomiona 23.11.2026 na
// serwerze sprawdzila wszystkich siedmiu operatorow z gmin graniczacych
// z miastem. Kanal POMAK-u oddal cztery wpisy z PELNA trescia i tytulami
// gotowymi do appki ("Przerwa w dostawie wody - Ploty"). Kanal Spolki
// Wodno-Sciekowej dziala, ale ma slabsze tytuly ("KOMUNIKAT", "UWAGA
// MIESZKANCY") i zwykle tylko zajawke tresci.
//
// WAZNE: bierzemy kanal GLOWNY Spolki (?feed=rss2), a nie kategorie
// "ogloszenia" (?feed=rss2&cat=5). Wydawaloby sie odwrotnie, ale sonda
// pokazala, ze kategoria konczy sie na lipcu, a kanal glowny ma wpisy
// z listopada - czyli najnowsze komunikaty nie sa tam kategoryzowane.

const Parser = require('rss-parser');
const { detectCategory, extractStreet } = require('./classify');
const { qualityCheck } = require('./qualityCheck');
const { extractPolishDate } = require('./polishDates');
const { LIMIT_ZRODLA } = require('./sanitize');

// Ta nazwa przechodzi przez zapory urzedowych stron. Slowa "bot" unikamy
// swiadomie - BIP PZZD odrzucal nas przez nie z HTTP 403.
const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'Accept': 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const ZRODLA = [
  {
    gmina: 'Czerwieńsk',
    zrodlo: 'POMAK Czerwieńsk',
    kanal: 'https://www.pomak.pl/?format=feed&type=rss',
  },
  {
    gmina: 'Nowogród Bobrzański',
    zrodlo: 'Spółka Wodno-Ściekowa Nowogród Bobrzański',
    kanal: 'https://spwsnow.pl/?feed=rss2',
  },
];

const LIMIT_CZASU_MS = 15000;

// Kanaly tych spolek zawieraja TYLKO biezace komunikaty i caly rok moga nie
// miec zadnej awarii. Pusty wynik jest wiec stanem normalnym i NIE moze
// uruchamiac alarmu - inaczej dostawalbys push o awarii zrodla za kazdym
// razem, gdy w gminach po prostu nie ma awarii wody. Alarmujemy wylacznie
// wtedy, gdy kanal przestaje odpowiadac.
const BLEDY_PRZED_ALERTEM = 8;   // ok. 80 minut pod rzad bledu pobierania
const stanKanalow = new Map();

// Zapowiedz odwolana w tym samym wpisie. POMAK dopisuje do istniejacego
// komunikatu akapit "AKTUALIZACJA - PRZYWROCENIE DOSTAWY WODY", zamiast
// publikowac nowy wpis. Bez tego mieszkaniec Plotow czytalby ostrzezenie
// o awarii, ktora juz sie skonczyla - a przy swiezej dacie poszedlby jeszcze
// push. Nie przepisujemy tekstu urzedu; dopisujemy wlasny znacznik do tytulu,
// zeby bylo to widoczne od razu, bez czytania calosci.
const ODWOLANIE_RE = new RegExp([
  'przywr[óo]cen\\w*\\s+dostaw',
  'przywr[óo]cono',
  'dostaw\\w*\\s+wody\\s+(zosta[łl]a\\s+)?przywr[óo]con',
  'wod[aę]\\s+(zosta[łl]a\\s+)?przywr[óo]con',
  'usuni[ęe]t\\w*\\s+awari',
  'usuni[ęe]to\\s+awari',
  'awaria\\s+(zosta[łl]a\\s+)?usuni[ęe]t',
].join('|'), 'i');

// ...ale sam ten wzorzec nie wystarcza i o tym powiedzial mi wlasny test.
// W komunikacie o Plotach stoi zdanie: "O przywroceniu dostaw wody
// poinformujemy w osobnym komunikacie" - czyli OBIETNICA informacji na
// przyszlosc, a nie koniec awarii. Wzorzec ja lapal, wiec komunikat
// o trwajacej awarii dostawalby w tytule "(zakonczona)". To blad w najgorsza
// strone: mieszkaniec Plotow przeczytalby, ze woda juz jest.
//
// Dlatego przed sprawdzeniem wyrzucamy zdania zawierajace obietnice. Jesli
// obietnica i odwolanie stoja w JEDNYM zdaniu, wypada cale - czyli pomylimy
// sie w bezpieczna strone: pokazemy awarie jako trwajaca, a nie odwolana.
// Uwaga na wtracenia: urzad pisze "zostana PANSTWO poinformowani", wiec
// miedzy czasownikiem a imieslowem moga stac jeszcze dwa slowa.
//
// I uwaga powazniejsza, ktora kosztowala mnie tu jedno podejscie: \w
// w JavaScripcie NIE obejmuje polskich znakow. "zostan\w*" zatrzymywalo sie
// na "zostan" i nie przechodzilo przez "ą" w "zostaną", a "\w+" nie lapalo
// "Państwo". Dlatego klasa liter jest tu wypisana jawnie - w polskim tekscie
// \w jest pulapka, nie skrotem.
const LITERA = '[A-Za-zĄĆĘŁŃÓŚŹŻąćęłńóśźż]';
const OBIETNICA_RE = new RegExp([
  'poinformujemy',
  'powiadomimy',
  'b[ęe]dziemy\\s+informowa',
  `zostan${LITERA}*(\\s+${LITERA}+){0,2}\\s+poinformowan`,
  `zostanie\\s+podan${LITERA}*\\s+w\\s+osobnym`,
].join('|'), 'i');

function czyOdwolana(tekst) {
  const zdania = String(tekst || '').split(/(?<=[.!?])\s+/);
  const istotne = zdania.filter((z) => !OBIETNICA_RE.test(z));
  return ODWOLANIE_RE.test(istotne.join(' '));
}

// extractStreet jest wspolny dla wszystkich zrodel i czasem zabiera za duzo:
// z "w miejscowosci Ploty przy ul. Letniej w godzinach od 9:00" wyciaga
// "ul. Letniej w godzinach od 9". W appce to pole stoi pod tytulem jako
// nazwa miejsca, wiec taki ogon wyglada jak blad. Nie zmieniam funkcji
// wspolnej - przycinam jej wynik tutaj, u siebie.
function przytnijMiejsce(nazwa) {
  if (!nazwa) return null;
  const przyciete = String(nazwa)
    .replace(/\s+w\s+(godzinach|godzinie|godz|dniu|dniach|okresie).*$/i, '')
    .replace(/\s+(od|do)\s+.*$/i, '')
    .replace(/[\s,;:.–—-]+$/, '')
    .trim();
  return przyciete.length >= 3 ? przyciete : null;
}

const MIEJSCOWOSC_RE = /\bw\s+(?:m\.|miejscowo[śs]ci)\s+([A-ZĄĆĘŁŃÓŚŹŻ][a-ząćęłńóśźż-]{2,})/;

function bezOgonkow(tekst) {
  return String(tekst || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ł/g, 'l');
}

/**
 * Tytul widziany przez mieszkanca. Nazwe gminy dopisujemy z przodu, bo
 * zakladka "wodociagi" pokazuje obok siebie awarie z miasta i z okolic -
 * bez tego czytelnik nie wie, czy sprawa go dotyczy. Jesli tytul juz
 * wymienia gmine ("PRZERWA W DOSTAWIE WODY - SUW PKP CZERWIENSK"), nie
 * powtarzamy jej drugi raz.
 */
function zbudujTytul(gmina, tytulZrodla, zakonczona) {
  const tytul = String(tytulZrodla || '').trim();
  const juzWymienia = bezOgonkow(tytul).includes(bezOgonkow(gmina));
  const podstawa = juzWymienia ? tytul : `${gmina}: ${tytul}`;
  return zakonczona ? `${podstawa} (zakończona)` : podstawa;
}

/**
 * Czy wpis to w ogole komunikat o przerwie w dostawie. Uzywamy tej samej
 * funkcji, ktora klasyfikuje komunikaty miasta - jest juz obloziona testami
 * i wymaga SYGNALU PRZERWY, a nie samej nazwy infrastruktury. To wazne, bo
 * w kanalach tych spolek obok awarii leza przetargi na osady sciekowe
 * i oferty pracy dla "Montera Sieci Wodociagowych" - sama nazwa sieci
 * wodociagowej nie czyni z nich utrudnienia.
 */
function kategoriaWpisu(tytul, opis) {
  const kategoria = detectCategory(`${tytul} ${opis}`);
  return kategoria === 'wodociagi' || kategoria === 'prad' ? kategoria : null;
}

function wyciagOpis(item) {
  // WordPress i Joomla wystawiaja w kanale dwie wersje tresci: zajawke
  // (<description>) i caly tekst (<content:encoded>). Pelna nic nie kosztuje.
  const pelna = (item['content:encodedSnippet'] || '').trim();
  const zajawka = (item.contentSnippet || '').trim();
  const tresc = pelna.length > zajawka.length ? pelna : zajawka;
  return tresc.replace(/\s+/g, ' ').trim().slice(0, LIMIT_ZRODLA);
}

function wykryjMiejsce(tytul, opis) {
  const zTytulu = przytnijMiejsce(extractStreet(tytul));
  if (zTytulu) return zTytulu;
  const zOpisu = przytnijMiejsce(extractStreet(opis));
  if (zOpisu) return zOpisu;
  const m = `${tytul} ${opis}`.match(MIEJSCOWOSC_RE);
  return m ? m[1] : null;
}

/**
 * Zamienia wpisy kanalu na wpisy appki. Bez sieci - zeby dalo sie to
 * sprawdzic testem na prawdziwych danych z kanalu.
 */
function przetworzWpisy(zrodlo, items) {
  const wyniki = [];
  let pominietych = 0;

  for (const item of items || []) {
    const tytulZrodla = String(item.title || '').replace(/\s+/g, ' ').trim();
    const link = String(item.link || '').trim();
    if (!tytulZrodla || !link) {
      pominietych += 1;
      continue;
    }

    const opis = wyciagOpis(item);
    const kategoria = kategoriaWpisu(tytulZrodla, opis);
    if (!kategoria) {
      pominietych += 1;
      continue;
    }

    const zakonczona = czyOdwolana(`${tytulZrodla} ${opis}`) && !ODWOLANIE_RE.test(tytulZrodla);

    const eventDate = extractPolishDate(opis) || extractPolishDate(tytulZrodla);
    const publikacja = item.isoDate || item.pubDate || null;

    wyniki.push(qualityCheck({
      source_url: link,
      source_name: zrodlo.zrodlo,
      category: kategoria,
      title: zbudujTytul(zrodlo.gmina, tytulZrodla, zakonczona),
      street: wykryjMiejsce(tytulZrodla, opis),
      description: opis || tytulZrodla,
      published_at: publikacja ? new Date(publikacja).toISOString() : null,
      event_date: eventDate ? eventDate.toISOString() : null,
    }));
  }

  return { wyniki, pominietych };
}

function odnotujBlad(zrodlo, szczegol) {
  const s = stanKanalow.get(zrodlo.kanal) || { bledy: 0, zgloszony: false };
  s.bledy += 1;
  stanKanalow.set(zrodlo.kanal, s);

  if (s.bledy >= BLEDY_PRZED_ALERTEM && !s.zgloszony) {
    s.zgloszony = true;
    console.error(`[gminy] UWAGA: kanal ${zrodlo.zrodlo} nie odpowiada od ${s.bledy} cykli `
      + `z rzedu (${szczegol}) - awarie wody w gminie ${zrodlo.gmina} moga nie docierac do appki`);
  }
}

function odnotujSukces(zrodlo) {
  const s = stanKanalow.get(zrodlo.kanal);
  if (s && s.bledy) {
    console.log(`[gminy] kanal ${zrodlo.zrodlo} znowu odpowiada (po ${s.bledy} bledach)`);
  }
  stanKanalow.set(zrodlo.kanal, { bledy: 0, zgloszony: false });
}

async function pobierzKanal(url) {
  const kontroler = new AbortController();
  const stoper = setTimeout(() => kontroler.abort(), LIMIT_CZASU_MS);
  try {
    const odp = await fetch(url, { headers: NAGLOWKI, redirect: 'follow', signal: kontroler.signal });
    if (!odp.ok) throw new Error(`HTTP ${odp.status}`);
    return await odp.text();
  } finally {
    clearTimeout(stoper);
  }
}

async function fetchGminy() {
  const wszystkie = [];
  const podsumowanie = [];

  for (const zrodlo of ZRODLA) {
    try {
      const xml = await pobierzKanal(zrodlo.kanal);
      const kanal = await new Parser().parseString(xml);
      const { wyniki, pominietych } = przetworzWpisy(zrodlo, kanal.items);

      odnotujSukces(zrodlo);
      wszystkie.push(...wyniki);
      podsumowanie.push(`${zrodlo.gmina}: ${(kanal.items || []).length} w kanale, `
        + `${wyniki.length} o wodzie, ${pominietych} pominietych`);

      for (const w of wyniki) {
        if (w.needs_review) {
          console.warn(`[gminy] wpis do przejrzenia (${w.title}):`, w.review_reasons.join('; '));
        }
      }
    } catch (err) {
      odnotujBlad(zrodlo, err.message);
      podsumowanie.push(`${zrodlo.gmina}: BLAD (${err.message})`);
    }
  }

  console.log(`[gminy] ${podsumowanie.join(' | ')}`);
  return wszystkie;
}

module.exports = {
  fetchGminy,
  przetworzWpisy,
  zbudujTytul,
  kategoriaWpisu,
  wyciagOpis,
  wykryjMiejsce,
  ZRODLA,
  ODWOLANIE_RE,
  czyOdwolana,
  przytnijMiejsce,
};
