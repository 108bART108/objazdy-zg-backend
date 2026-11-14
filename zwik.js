const cheerio = require('cheerio');
const { extractStreet } = require('./classify');
const { qualityCheck } = require('./qualityCheck');
const { extractPolishDate } = require('./polishDates');
const { getDescriptionsByUrls } = require('./db');
const { LIMIT_ZRODLA } = require('./sanitize');

// ZWiK publikuje na jednej stronie DWIE rozne rzeczy:
//  1. przerwy w dostawie wody ("nie bedzie wody na ul. X") - zakladka "woda",
//  2. zapowiedzi robot, ktore zamykaja fragment ulicy - zakladka "drogi".
//
// Dawniej wszystko z ZWiK dostawalo na sztywno kategorie "wodociagi". Przez
// to komunikat zatytulowany wprost "Utrudnienia w ruchu na al. Konstytucji
// 3 Maja" wisial w zakladce "woda" (13.11.2026) - mieszkaniec szukal go
// w "drogi" i nie znajdowal, a w "woda" trafial na wpis, ktory wcale nie
// zapowiadal braku wody.
//
// Kierunek bledu nie jest symetryczny: przeoczona przerwa w dostawie wody
// jest grozniejsza niz komunikat drogowy w nieoczywistej zakladce. Dlatego
// "wodociagi" zostaje domyslna kategoria, a na "drogi" przenosimy wpis
// TYLKO wtedy, gdy wprost mowi o ruchu i jednoczesnie NIE zapowiada przerwy
// w dostawie wody.
const PRZERWA_WODY_RE = new RegExp([
  'awari',
  'przerw\\w*\\s+w\\s+dostaw',
  'brak\\w*\\s+wody',
  'bez\\s+wody',
  'wstrzyman\\w*\\s+dostaw',
  'nie\\s+b[ęe]dzie\\s+wody',
  'nie\\s+pop[łl]ynie\\s+woda',
].join('|'), 'i');

const RUCH_RE = new RegExp([
  'utrudnieni\\w*\\s+w\\s+ruchu',
  'organizacj\\w*\\s+ruchu',
  'zamkni[ęe]ci\\w*\\s+(ulic|drog|skrzy[żz])',
  'objazd',
  'nieprzejezdn',
  'ruch\\w*\\s+wahad[łl]ow',
  'zw[ęe][żz]eni\\w*\\s+(jezdni|ulic|drog)',
].join('|'), 'i');

function kategoriaZwik(title, description) {
  const tekst = `${title} ${description}`;
  if (PRZERWA_WODY_RE.test(tekst)) return 'wodociagi';
  if (RUCH_RE.test(tekst)) return 'drogi';
  return 'wodociagi';
}

const PAGE_URL = 'https://www.zwik.zgora.pl/aktualnosci/awarie-i-remonty/';
const PERMALINK_RE = /^https?:\/\/www\.zwik\.zgora\.pl\/\d{4}\/\d{2}\/[a-z0-9-]+\/?$/i;
const NOISE_TEXTS = ['czytaj więcej', 'awarie i remonty', 'strona główna'];

const MONTH_ABBR = {
  sty: 0, lut: 1, mar: 2, kwi: 3, maj: 4, cze: 5,
  lip: 6, sie: 7, wrz: 8, paz: 9, paź: 9, lis: 10, gru: 11,
};

function parseRelativeDate(text, now) {
  let m = text.match(/^Dzisiaj\s+o\s+(\d{2}):(\d{2})/i);
  if (m) {
    const d = new Date(now);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  }
  m = text.match(/^Wczoraj\s+o\s+(\d{2}):(\d{2})/i);
  if (m) {
    const d = new Date(now);
    d.setDate(d.getDate() - 1);
    d.setHours(Number(m[1]), Number(m[2]), 0, 0);
    return d;
  }
  m = text.match(/^(\d{1,2})\s+([a-zżźćąśęłóń]{3})[a-zżźćąśęłóń]*\s+o\s+(\d{2}):(\d{2})/iu);
  if (m) {
    const day = Number(m[1]);
    const month = MONTH_ABBR[m[2].toLowerCase()];
    if (month !== undefined) {
      const d = new Date(now.getFullYear(), month, day, Number(m[3]), Number(m[4]));
      if (d.getTime() > now.getTime() + 86400000) d.setFullYear(d.getFullYear() - 1);
      return d;
    }
  }
  return null;
}

// Strona z lista komunikatow ZWiK pokazuje tylko ZAJAWKE - ucina tekst
// i konczy go wielokropkiem. Przy awarii wodociagu zajawka urywa sie
// w srodku listy ulic, wiec mieszkaniec dalszej czesci nie widzi wcale.
// Naszych limitow to nie dotyczy: tresc przychodzi juz ucieta ze zrodla.
// Pelna wersja jest na podstronie komunikatu ("Czytaj wiecej"), wiec
// dla ucietych zajawek siegamy po nia.
const KONCOWKA_URWANIA_RE = /(?:…|\.\.\.|\[…\]|\[\.\.\.\])\s*$/;

// Pobrania sa kroplowe - to zwykla strona WWW, nie API.
const MAX_POBRAN_SZCZEGOLOW = 4;

function wygladaNaZajawke(tekst) {
  return KONCOWKA_URWANIA_RE.test(String(tekst || '').trim());
}

// Wybiera kontener z najwieksza iloscia tekstu akapitowego i skleja jego
// akapity oraz punkty list w kolejnosci dokumentu.
function wyciagTrescPodstrony(html) {
  const $ = cheerio.load(html);
  $('script, style, nav, header, footer, aside, form').remove();

  let $najlepszy = null;
  let najwiecej = 0;
  $('article, main, .entry-content, .post-content, .content, div').each((_, el) => {
    const dlugosc = $(el).find('p, li').text().replace(/\s+/g, ' ').trim().length;
    if (dlugosc > najwiecej) {
      najwiecej = dlugosc;
      $najlepszy = $(el);
    }
  });
  if (!$najlepszy) return '';

  const czesci = [];
  $najlepszy.find('p, li').each((_, el) => {
    const t = $(el).text().replace(/\s+/g, ' ').trim();
    // Te same etykiety co na liscie komunikatow - na podstronie rowniez
    // potrafia stac w osobnym akapicie i wchodzic na koniec opisu
    // ("...przepraszamy! Awarie i remonty").
    const smiec = !t || NOISE_TEXTS.some((n) => t.toLowerCase() === n || t.toLowerCase().startsWith(n));
    if (!smiec) czesci.push(t);
  });
  return czesci.join(' ').replace(/\s+/g, ' ').trim();
}

// Uzupelnia uciete zajawki trescia z podstron.
//
// ZABEZPIECZENIE: nie mam tu dostepu do prawdziwego HTML-a ZWiK-u, wiec
// wyciaganie tresci z podstrony jest napisane "w ciemno". Dlatego wynik
// jest przyjmowany TYLKO wtedy, gdy przeszedl trzy kontrole: jest dluzszy
// niz zajawka, nie konczy sie wielokropkiem i ZAWIERA poczatek zajawki
// (czyli na pewno pochodzi z tego samego komunikatu, a nie z menu czy
// stopki). Jesli ktorakolwiek zawiedzie - zostaje zajawka, czyli stan
// sprzed zmiany. W najgorszym razie nic sie nie poprawi, ale nic tez
// nie moze sie zepsuc. Log mowi, co sie wydarzylo.
async function uzupelnijZajawki(kandydaci, znaneOpisy) {
  let pobran = 0;

  for (const k of kandydaci) {
    if (!wygladaNaZajawke(k.description)) continue;

    const zBazy = znaneOpisy.get(k.href);
    if (zBazy && zBazy.length > k.description.length && !wygladaNaZajawke(zBazy)) {
      k.description = zBazy;
      continue;
    }

    if (pobran >= MAX_POBRAN_SZCZEGOLOW) continue;
    pobran += 1;

    try {
      const res = await fetch(k.href, {
        headers: { 'User-Agent': 'UtrudnieniaZG-bot/1.0 (+info@utrudnienia-zg.pl)' },
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const pelny = wyciagTrescPodstrony(await res.text());

      // Sprawdzamy POCZATEK albo KONIEC zajawki - wystarczy jedno.
      //
      // Sam poczatek nie wystarczyl: zajawka komunikatu "Utrudnienia w ruchu
      // na al. Konstytucji 3 Maja" zaczynala sie od etykiety listy
      // (", Wiadomosci Informujemy, ze..."), ktorej na podstronie nie ma -
      // wiec kontrola odrzucala poprawnie pobrana tresc. Koncowka zajawki
      // to zawsze prawdziwy tekst komunikatu, wiec jest lepszym punktem
      // zaczepienia; pierwsze, uciete slowo odrzucamy.
      const zajawka = k.description.replace(KONCOWKA_URWANIA_RE, '').trim();
      const poczatek = zajawka.slice(0, 40);
      const koniec = zajawka.slice(-45).replace(/^\S*\s/, '').trim();

      const zawiera = (fragment) => fragment.length >= 20
        && pelny.toLowerCase().includes(fragment.toLowerCase());
      const pasuje = zawiera(poczatek) || zawiera(koniec);

      if (pelny && pelny.length > k.description.length && !wygladaNaZajawke(pelny) && pasuje) {
        console.log(`[zwik] uzupelniono uciety opis z podstrony (${k.description.length} -> ${pelny.length} zn.): "${k.title}"`);
        k.description = pelny.slice(0, LIMIT_ZRODLA);
      } else {
        console.warn(`[zwik] podstrona nie dala pelniejszej tresci - zostaje zajawka: "${k.title}"`);
      }
    } catch (err) {
      console.warn(`[zwik] nie udalo sie pobrac podstrony (${k.href}): ${err.message}`);
    }
  }
}

async function fetchZwik() {
  const results = [];
  try {
    const res = await fetch(PAGE_URL, {
      headers: { 'User-Agent': 'UtrudnieniaZG-bot/1.0 (+info@utrudnienia-zg.pl)' },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const base = new URL(PAGE_URL).origin;
    const seen = new Set();
    const kandydaci = [];
    const now = new Date();

    $('h2').each((_, el) => {
      const $h2 = $(el);
      const $a = $h2.find('a[href]').first();
      let href = $a.attr('href') || '';
      if (href.startsWith('/')) href = `${base}${href}`;
      if (!PERMALINK_RE.test(href)) return;
      if (seen.has(href)) return;
      seen.add(href);

      const title = $h2.text().replace(/\s+/g, ' ').trim();
      if (!title) return;

      const parts = [];
      let $next = $h2.next();
      let guard = 0;
      while ($next.length && !$next.is('h2') && guard < 8) {
        const t = $next.text().replace(/\s+/g, ' ').trim();
        const isNoise = !t || NOISE_TEXTS.some((n) => t.toLowerCase() === n || t.toLowerCase().startsWith(n));
        if (t && !isNoise) parts.push(t);
        $next = $next.next();
        guard++;
      }
      const rawText = parts.join(' ');

      // Jesli nie uda sie rozpoznac daty - przekazujemy null (nie "teraz"!).
      // Baza danych sama zdecyduje: dla nowego wpisu uzyje dzisiejszej daty
      // jako jedynego rozsadnego przyblizenia, a dla juz istniejacego wpisu
      // ZACHOWA poprzednio zapisana, dobra date zamiast ja nadpisywac.
      const parsedDate = parseRelativeDate(rawText, now);

      const description = rawText
        .replace(/Awarie i remonty/gi, '')
        .replace(/Czytaj więcej/gi, '')
        .replace(/^\s*(Dzisiaj|Wczoraj|\d{1,2}\s+\p{L}+)\s+o\s+\d{2}:\d{2}\s*/iu, '')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, LIMIT_ZRODLA);
      if (!description) return;

      kandydaci.push({ href, title, description, parsedDate, opisZListy: description });
    });

    // Uciete zajawki uzupelniamy trescia z podstron. Musi to byc PO petli,
    // bo cheerio .each() jest synchroniczne i nie da sie w nim czekac na
    // pobranie strony.
    const znaneOpisy = getDescriptionsByUrls(kandydaci.map((k) => k.href));
    await uzupelnijZajawki(kandydaci, znaneOpisy);

    for (const k of kandydaci) {
      const { href, title, description, parsedDate } = k;

      // Wiekszosc wpisow ZWiK to biezace awarie (juz parsowane wyzej jako
      // published_at), ale czasem opis zapowiada konkretna, przyszla date
      // (np. planowany remont) - lapiemy ja tez jako event_date, zeby
      // dostac te sama zolta plakietke co Enea/ZDW gdy to zasadne.
      const eventDate = extractPolishDate(description) || extractPolishDate(title);

      // UWAGA: kategorie liczymy z tekstu Z LISTY, a nie z uzupelnionego
      // opisu. Komunikat "Utrudnienia w ruchu na al. Konstytucji 3 Maja"
      // to zapowiedz robot i ma byc w zakladce "drogi" - ale jego pelna
      // tresc z podstrony potrafi gdzies wspomniec o przerwie w dostawie
      // wody i wtedy wrocilby do "wody", czyli dokladnie tam, skad go
      // 13.11.2026 wyciagalismy. Dluzszy tekst sluzy do CZYTANIA,
      // o zakladce decyduje to, czym komunikat jest.
      const checked = qualityCheck({
        source_url: href,
        source_name: 'ZWiK Zielona Gora',
        category: kategoriaZwik(title, k.opisZListy || description),
        title,
        street: extractStreet(description) || extractStreet(title),
        description,
        published_at: parsedDate ? parsedDate.toISOString() : null,
        event_date: eventDate ? eventDate.toISOString() : null,
      });
      if (checked.needs_review) {
        console.warn(`[zwik] wpis oznaczony do przejrzenia (${title}):`, checked.review_reasons.join('; '));
      }
      results.push(checked);
    }
  } catch (err) {
    console.error('[zwik] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchZwik };
