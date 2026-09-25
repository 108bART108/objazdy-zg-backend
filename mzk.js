const cheerio = require('cheerio');
const https = require('https');
const { extractStreet } = require('./classify');
const { qualityCheck } = require('./qualityCheck');
const { extractPolishDate } = require('./polishDates');

// Strona MZK domyslnie pokazuje tylko 8 najnowszych wpisow. Wariant "/16/"
// to ta sama lista z 16 pozycjami na stronie - bierzemy go jako pierwszy,
// zeby jeden nieodswiezony cykl nie spowodowal przegapienia wpisu. Gdyby
// ten adres przestal dzialac, uzywamy zwyklej listy.
const PAGE_URLS = [
  'https://www.mzk.zgora.pl/aktualnosci/16/',
  'https://www.mzk.zgora.pl/aktualnosci',
];

// WAZNE: nazwa przegladarki bez slowa "bot". Zabezpieczenia stron czesto
// odrzucaja zapytania z "bot" w User-Agent, odpowiadajac pusta strona z
// kodem 200 - czyli scraper "dziala", ale nie widzi zadnych wpisow.
// Dokladnie to bylo przyczyna tego, ze kategoria MZK przestala sie
// aktualizowac, mimo ze strona MZK byla dostepna.
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
  'Cache-Control': 'no-cache',
};

// Akapity typu "stopka firmowa" (nazwa spolki, adres, NIP) czesto sa
// dluzsze niz 60 znakow i pojawiaja sie PRZED wlasciwa trescia komunikatu
// - trzeba je jawnie pomijac, zamiast brac "pierwszy dluzszy <p>".
const BOILERPLATE_RE = /sp[oó]łka z ograniczon[aą] odpowiedzialno|\bnip:?\s*\d|\bregon:?\s*\d|pliki?\s+cookies?|ustawie(ń|niami)?\s+(dotycz\S*\s+)?cookies|ustawieniami\s+przegl\p{L}darki|korzystaj\p{L}c\s+z\s+(naszego\s+)?serwisu\s+bez\s+zmiany/iu;

// ===================== POBIERANIE STRONY Z OBEJSCIAMI =====================
// Serwer Render nie potrafil polaczyc sie z mzk.zgora.pl - fetch konczyl sie
// bledem "fetch failed" po ~10 sekundach, czyli po limicie czasu na
// polaczenie. Nie byla to blokada bota (nie dostalismy zadnej odpowiedzi),
// tylko problem z samym polaczeniem. Dlatego probujemy po kolei:
//   1. zwykly fetch (IPv6 albo IPv4, zaleznie od systemu),
//   2. wymuszone IPv4 - czesta przyczyna takich bledow to niedzialajacy
//      adres IPv6 strony, na ktory Node trafia jako pierwszy,
//   3. opcjonalny serwer posredniczacy, jesli ustawisz zmienna
//      srodowiskowa MZK_PROXY_URL (np. "https://api.allorigins.win/raw?url=").
//      Przydatne, gdyby strona blokowala adresy IP serwerowni.
// Kazda nieudana proba trafia do logow z konkretna przyczyna, zamiast
// ogolnego "fetch failed".

function opisBledu(err) {
  const cause = err && err.cause;
  if (cause && (cause.code || cause.message)) {
    return `${err.message} (${cause.code || ''} ${cause.message || ''})`.trim();
  }
  return err ? err.message : 'nieznany blad';
}

// Pobranie przez modul https z wymuszona wersja protokolu IP.
function fetchPrzezHttps(url, family, timeoutMs = 15000, redirectsLeft = 2) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: HEADERS, family, timeout: timeoutMs }, (res) => {
      const { statusCode, headers } = res;
      if (statusCode >= 300 && statusCode < 400 && headers.location && redirectsLeft > 0) {
        res.resume();
        const next = new URL(headers.location, url).href;
        fetchPrzezHttps(next, family, timeoutMs, redirectsLeft - 1).then(resolve, reject);
        return;
      }
      if (statusCode >= 400) {
        res.resume();
        reject(new Error(`HTTP ${statusCode}`));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: statusCode, html: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`przekroczony czas ${timeoutMs}ms`)));
    req.on('error', reject);
  });
}

async function pobierzStrone(url) {
  const bledy = [];

  // 1. Zwykly fetch
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: res.status, html: await res.text() };
  } catch (err) {
    bledy.push(`fetch: ${opisBledu(err)}`);
  }

  // 2. Wymuszone IPv4
  try {
    const res = await fetchPrzezHttps(url, 4);
    console.log(`[mzk] ${url}: zwykly fetch zawiodl, ale IPv4 zadzialalo`);
    return res;
  } catch (err) {
    bledy.push(`IPv4: ${opisBledu(err)}`);
  }

  // 3. Opcjonalny serwer posredniczacy
  const proxy = process.env.MZK_PROXY_URL;
  if (proxy) {
    try {
      const res = await fetch(proxy + encodeURIComponent(url), { headers: HEADERS });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      console.log(`[mzk] ${url}: pobrano przez serwer posredniczacy`);
      return { status: res.status, html: await res.text() };
    } catch (err) {
      bledy.push(`proxy: ${opisBledu(err)}`);
    }
  }

  throw new Error(`nie udalo sie pobrac ${url} - ${bledy.join(' | ')}`);
}

async function fetchArticleDescription(url) {
  try {
    const { html } = await pobierzStrone(url);
    const $ = cheerio.load(html);

    // Wstaw spacje w miejscu <br>, zeby sklejone linie nie zlepily sie
    // w jedno slowo po .text() - dotyczy calego dokumentu, nie tylko
    // wybranego akapitu, bo listy (<ul>) tez czesto uzywaja <br>.
    $('br').replaceWith(' ');

    // Krok 1: znajdz PIERWSZY sensowny (nie-boilerplate) akapit dluzszy
    // niz 60 znakow - to nasz kandydat na opis.
    let $candidate = null;
    let candidateText = null;
    $('p').each((_, el) => {
      if (candidateText) return;
      const $el = $(el);
      const t = $el.text().replace(/\s+/g, ' ').trim();
      if (t.length > 60 && !BOILERPLATE_RE.test(t)) {
        $candidate = $el;
        candidateText = t;
      }
    });
    if (!candidateText) return null;

    // Krok 2: jesli akapit KONCZY SIE DWUKROPKIEM, to prawie na pewno
    // zapowiada liste, ktora nastepuje zaraz po nim (np. lista linii
    // autobusowych) - doklejamy ja, zeby nie urywac informacji w polowie.
    if (/:\s*$/.test(candidateText)) {
      const $listEl = $candidate.nextAll('ul, ol').first();
      if ($listEl.length) {
        const items = [];
        $listEl.find('li').each((_, li) => {
          const t = $(li).text().replace(/\s+/g, ' ').trim();
          if (t) items.push(t);
        });
        if (items.length) {
          candidateText = `${candidateText} ${items.join(', ')}`;
        }
      }
    } else if (candidateText.length < 100) {
      // Krok 3: jesli akapit jest krotki i NIE konczy sie dwukropkiem
      // (czyli to raczej niedokonczona/uboga informacja niz zapowiedz
      // listy), doklejamy jeszcze kolejny sensowny akapit dla kontekstu.
      const $nextP = $candidate.nextAll('p').first();
      if ($nextP.length) {
        const nextText = $nextP.text().replace(/\s+/g, ' ').trim();
        if (nextText.length > 20 && !BOILERPLATE_RE.test(nextText)) {
          candidateText = `${candidateText} ${nextText}`;
        }
      }
    }

    return candidateText.slice(0, 400);
  } catch (err) {
    console.error(`[mzk] blad pobierania opisu artykulu (${url}):`, err.message);
    return null;
  }
}

// Pobiera liste artykulow z jednego adresu. Zwraca tablice artykulow -
// pusta, jesli strona odpowiedziala, ale nic nie pasowalo (wtedy warto
// sprobowac innego adresu).
async function fetchListing(pageUrl) {
  const { status, html } = await pobierzStrone(pageUrl);
  const $ = cheerio.load(html);
  const base = new URL(pageUrl).origin;
  const seen = new Set();
  const articles = [];

  $('a[href*="/aktualnosci/"]').each((_, el) => {
      const $a = $(el);
      let href = $a.attr('href') || '';
      if (!/-i\d+\/?$/.test(href)) return;

      if (href.startsWith('/')) href = `${base}${href}`;
      if (seen.has(href)) return;
      seen.add(href);

      const rawText = $a.text().replace(/\s+/g, ' ').trim();
      if (!rawText) return;

      const dateMatch = rawText.match(/(\d{2})\.(\d{2})\.(\d{4})/);
      let title = rawText;
      if (dateMatch) {
        const parts = rawText.split(dateMatch[0]);
        title = (parts[1] || parts[0]).trim();
      }
      if (!title) return;

      // Jesli nie znajdziemy daty w tekscie linku - przekazujemy null
      // (nie date scrapowania), zeby baza mogla sama zdecydowac.
      let publishedAt = null;
      if (dateMatch) {
        const [, dd, mm, yyyy] = dateMatch;
        const d = new Date(`${yyyy}-${mm}-${dd}T12:00:00`);
        if (!isNaN(d.getTime())) publishedAt = d.toISOString();
      }

    articles.push({ href, title, publishedAt });
  });

  // Diagnostyka: gdy strona odpowiedziala, ale nie znalezlismy ani jednego
  // artykulu, zapisujemy w logach poczatek otrzymanej tresci. Dzieki temu
  // od razu widac, czy dostalismy prawdziwa strone, czy np. komunikat
  // zabezpieczenia - zamiast zgadywac przyczyne.
  if (!articles.length) {
    const preview = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    console.warn(`[mzk] ${pageUrl}: 0 artykulow (HTTP ${status}, ${html.length} znakow). Poczatek tresci: "${preview}"`);
  }
  return articles;
}

async function fetchMzk() {
  const results = [];
  try {
    let articles = [];
    for (const pageUrl of PAGE_URLS) {
      try {
        articles = await fetchListing(pageUrl);
        if (articles.length) break; // udalo sie - nie probujemy kolejnego adresu
      } catch (err) {
        // Blad jednego adresu nie moze przerwac proby kolejnego.
        console.warn(`[mzk] ${err.message}`);
      }
    }
    if (!articles.length) {
      console.error('[mzk] zaden z adresow nie zwrocil artykulow - sprawdz logi powyzej');
      return results;
    }

    const limited = articles.slice(0, 15);
    const descriptions = await Promise.all(
      limited.map((a) => fetchArticleDescription(a.href))
    );

    limited.forEach((a, i) => {
      const description = descriptions[i] || a.title;
      // Wyciagamy konkretna date wydarzenia (np. "31 sierpnia") z opisu,
      // a jak jej tam nie ma - probujemy z tytulu. Dzieki temu appka moze
      // pokazac te sama zolta plakietke "Dzisiaj/Jutro/za X dni" co juz
      // dziala dla kategorii Prad (Enea).
      const eventDate = extractPolishDate(description) || extractPolishDate(a.title);
      const checked = qualityCheck({
        source_url: a.href,
        source_name: 'MZK Zielona Gora',
        category: 'mzk',
        title: a.title,
        street: extractStreet(description) || extractStreet(a.title),
        description,
        published_at: a.publishedAt,
        event_date: eventDate ? eventDate.toISOString() : null,
      });
      if (checked.needs_review) {
        console.warn(`[mzk] wpis oznaczony do przejrzenia (${a.href}):`, checked.review_reasons.join('; '));
      }
      results.push(checked);
    });
  } catch (err) {
    console.error('[mzk] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchMzk };
