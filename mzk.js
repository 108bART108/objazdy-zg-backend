const cheerio = require('cheerio');
const { getDescriptionsByUrls } = require('./db');
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

// MZK ma osobna zakladke "Komunikaty" - to tam trafiaja nagle awarie i
// objazdy, ktore nie ida do "Aktualnosci". Czytamy ja ZAWSZE dodatkowo
// (nie zamiast), bo bywa pusta.
const KOMUNIKATY_URL = 'https://www.mzk.zgora.pl/komunikaty';

// Komunikat, ktorym strona MZK sama oznajmia pusta liste. Rozpoznajemy go,
// zeby nie traktowac poprawnie dzialajacej, ale pustej zakladki jako bledu.
// Kilka wariantow zapisu na wypadek drobnej zmiany tresci.
const STRONA_PUSTA_WZORZEC = /brak\s+(komunikat|aktualno|wpis|artykul|informacj)/i;

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

// Gdy strona blokuje nasz adres IP, kazda proba konczy sie dopiero po
// wygasnieciu limitu czasu - a to oznacza, ze KAZDY cykl scrapowania
// (co 30 minut) marnuje kilkadziesiat sekund na czekanie. Dlatego po
// wykryciu problemu z samym polaczeniem robimy godzinna przerwe:
// scraper nie probuje w kolko, ale co godzine sprawdza, czy blokada
// zostala zdjeta.
// Cykle chodza co 10 minut, wiec przerwa po calkowitej awarii jest
// krotsza niz przy 30-minutowych - i tak oszczedza czas, a szybciej
// wykryje powrot zrodla do zycia.
const PRZERWA_PO_BLOKADZIE_MS = 20 * 60 * 1000;
let przerwaDo = 0;
let wolProxy = false; // po nieudanym polaczeniu bezposrednim zaczynamy od proxy

function toBladPolaczenia(komunikat) {
  return /CONNECT_TIMEOUT|przekroczony czas|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET/i.test(komunikat);
}

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

// Lista serwerow posredniczacych. Pojedynczy darmowy posrednik to
// pojedynczy punkt awarii - gdy przestanie dzialac, kategoria MZK po cichu
// zamiera. Dlatego probujemy kilku po kolei, a ten, ktory ostatnio
// zadzialal, zapamietujemy i uzywamy jako pierwszego.
// MZK_PROXY_URL (jesli ustawione) ma pierwszenstwo przed lista wbudowana.
// Usuniete 29.10.2026 po analizie logow:
//   thingproxy.freeboard.io - serwer nie istnieje (ENOTFOUND, znikl z DNS)
//   corsproxy.io            - odpowiada HTTP 401, wymaga teraz klucza API
// Oba zawodzily ZA KAZDYM RAZEM, a kazda proba kosztowala limit czasu.
// Przy dwoch adresach na cykl marnowalo to okolo polowy z 2,5 minuty,
// ktore zajmowalo wtedy scrapowanie.
const PROXY_WBUDOWANE = [
  'https://api.allorigins.win/raw?url=',
  'https://api.codetabs.com/v1/proxy/?quest=',
];

// Limit czasu na jednego posrednika. 20 sekund bylo ustawieniem "na wszelki
// wypadek" - przy czterech posrednikach i dwoch adresach dawalo to w
// najgorszym razie ponad dwie minuty czekania na z gory przegrana sprawe.
// Strona MZK wazy ok. 37 kB, wiec sprawny posrednik oddaje ja grubo
// ponizej 10 sekund.
const PROXY_TIMEOUT_MS = 10000;

// Jak dlugo po calkowitej porazce nie probowac posrednikow ponownie.
// Scraper pobiera w jednym cyklu kilka adresow; bez tego kazdy z nich
// powtarzalby cala przegrana liste od poczatku.
const PROXY_PRZERWA_MS = 60000;
let proxyPadlyDo = 0;

// Posrednicy, ktorzy zawodza TRWALE (nie istnieja albo odmawiaja dostepu),
// sa odstawiani automatycznie na dobe. Dzieki temu kolejny posrednik,
// ktory zniknie albo zacznie wymagac klucza - a to sie darmowym serwisom
// zdarza - nie bedzie spowalnial scrapowania az do recznej poprawki.
const TRWALE_PORAZKI_PRZED_ODSTAWIENIEM = 3;
const ODSTAWIENIE_MS = 24 * 3600 * 1000;
const odstawieni = new Map();   // proxy -> do kiedy odstawiony
const trwalePorazki = new Map(); // proxy -> licznik

function toTrwalaPorazka(komunikat) {
  // Serwer nie istnieje, odmawia dostepu albo zada klucza - powtarzanie
  // proby niczego nie zmieni.
  return /ENOTFOUND|HTTP 401|HTTP 403|HTTP 407|ERR_INVALID_URL/i.test(komunikat);
}

function zapiszPorazkeProxy(proxy, komunikat) {
  if (!toTrwalaPorazka(komunikat)) {
    trwalePorazki.delete(proxy);
    return;
  }
  const n = (trwalePorazki.get(proxy) || 0) + 1;
  trwalePorazki.set(proxy, n);
  if (n >= TRWALE_PORAZKI_PRZED_ODSTAWIENIEM) {
    odstawieni.set(proxy, Date.now() + ODSTAWIENIE_MS);
    trwalePorazki.delete(proxy);
    console.warn(`[mzk] odstawiam posrednika ${proxy.split('/')[2]} na dobe - zawiodl ${n} razy trwale (${komunikat})`);
  }
}

function czyOdstawiony(proxy) {
  const doKiedy = odstawieni.get(proxy);
  if (!doKiedy) return false;
  if (Date.now() >= doKiedy) {
    // Po dobie dajemy jeszcze jedna szanse - serwis mogl wrocic.
    odstawieni.delete(proxy);
    return false;
  }
  return true;
}

function listaProxy() {
  const wlasne = (process.env.MZK_PROXY_URL || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);
  // Wlasny posrednik z MZK_PROXY_URL nigdy nie jest odstawiany - to swiadomy
  // wybor administratora, a nie darmowy serwis, ktory moze zniknac.
  const wszystkie = [...wlasne, ...PROXY_WBUDOWANE.filter((p) => !czyOdstawiony(p))];
  // Posrednik, ktory ostatnio zadzialal, idzie na poczatek kolejki.
  if (dzialajacyProxy && wszystkie.includes(dzialajacyProxy)) {
    return [dzialajacyProxy, ...wszystkie.filter((p) => p !== dzialajacyProxy)];
  }
  return wszystkie;
}

let dzialajacyProxy = null;

// Sprawdza, czy pobrana tresc to naprawde strona MZK, a nie komunikat
// bledu posrednika (niektore zwracaja HTTP 200 z trescia typu "rate limit
// exceeded"). Bez tego scraper uznalby taka odpowiedz za pusta strone.
function wygladaJakStronaMzk(html) {
  if (!html) return false;
  // Komunikaty bledow posrednikow sa krotkie - prawdziwa strona MZK ma
  // menu, stopke i banery, wiec zawsze znacznie wiecej niz 1500 znakow.
  if (html.length < 1500) return false;
  // Celowo sprawdzamy, czy to NIE jest komunikat bledu, zamiast wymagac
  // konkretnych slow - inaczej zmiana tresci strony MZK zepsulaby scraper.
  const poczatek = html.slice(0, 600).toLowerCase();
  const bledyProxy = /rate limit|too many requests|quota exceeded|forbidden|access denied|service unavailable|proxy error/;
  if (bledyProxy.test(poczatek)) return false;
  // Musi byc dokumentem HTML, a nie np. JSON-em z bledem.
  return /<html|<body|<!doctype/i.test(html);
}

async function przezProxy(url) {
  // Jesli cala lista padla przed chwila, nie powtarzamy jej dla kolejnego
  // adresu w tym samym cyklu - to byla druga polowa zmarnowanego czasu.
  if (Date.now() < proxyPadlyDo) {
    throw new Error('wszyscy posrednicy zawiedli przed chwila - pomijam ponowna probe w tym cyklu');
  }

  const bledy = [];
  const lista = listaProxy();
  if (!lista.length) {
    throw new Error('brak dostepnych posrednikow (wszyscy odstawieni jako trwale niedzialajacy)');
  }

  for (const proxy of lista) {
    try {
      const res = await fetch(proxy + encodeURIComponent(url), {
        headers: HEADERS,
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const html = await res.text();
      if (!wygladaJakStronaMzk(html)) {
        throw new Error(`odpowiedz nie wyglada na strone MZK (${html.length} znakow)`);
      }
      if (dzialajacyProxy !== proxy) {
        console.log(`[mzk] dzialajacy posrednik: ${proxy}`);
        dzialajacyProxy = proxy;
      }
      trwalePorazki.delete(proxy);
      proxyPadlyDo = 0;
      return { status: res.status, html };
    } catch (err) {
      const opis = opisBledu(err);
      bledy.push(`${proxy.split('/')[2]}: ${opis}`);
      zapiszPorazkeProxy(proxy, opis);
      if (dzialajacyProxy === proxy) dzialajacyProxy = null;
    }
  }
  proxyPadlyDo = Date.now() + PROXY_PRZERWA_MS;
  throw new Error(`wszystkie serwery posredniczace zawiodly - ${bledy.join(' | ')}`);
}

async function bezposrednio(url) {
  const bledy = [];
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return { status: res.status, html: await res.text() };
  } catch (err) {
    bledy.push(`fetch: ${opisBledu(err)}`);
  }
  try {
    const res = await fetchPrzezHttps(url, 4, 8000);
    console.log(`[mzk] ${url}: zwykly fetch zawiodl, ale IPv4 zadzialalo`);
    return res;
  } catch (err) {
    bledy.push(`IPv4: ${opisBledu(err)}`);
  }
  throw new Error(bledy.join(' | '));
}

async function pobierzStrone(url) {
  const bledy = [];
  const mamyProxy = listaProxy().length > 0;
  let probowanoProxy = false;

  // Jesli poprzednio polaczenie bezposrednie bylo blokowane, a mamy
  // skonfigurowany serwer posredniczacy - zaczynamy od niego, zeby nie
  // czekac za kazdym razem na wygasniecie limitow czasu.
  if (mamyProxy && wolProxy) {
    probowanoProxy = true;
    try {
      const res = await przezProxy(url);
      console.log(`[mzk] ${url}: pobrano przez serwer posredniczacy`);
      przerwaDo = 0; // posrednik dziala - koniec przerwy
      return res;
    } catch (err) {
      bledy.push(`proxy: ${opisBledu(err)}`);
    }
  }

  let blokadaPolaczenia = false;
  try {
    const res = await bezposrednio(url);
    wolProxy = false;
    przerwaDo = 0; // polaczenie znow dziala - koniec przerwy
    return res;
  } catch (err) {
    bledy.push(err.message);
    blokadaPolaczenia = toBladPolaczenia(err.message);
    if (blokadaPolaczenia) wolProxy = true;
  }

  // Proxy jako ostatnia deska ratunku - takze wtedy, gdy polaczenie
  // bezposrednie jest blokowane (to wlasnie po to je ustawiamy).
  if (mamyProxy && !probowanoProxy) {
    try {
      const res = await przezProxy(url);
      console.log(`[mzk] ${url}: pobrano przez serwer posredniczacy`);
      przerwaDo = 0; // posrednik dziala - koniec przerwy
      return res;
    } catch (err) {
      bledy.push(`proxy: ${opisBledu(err)}`);
    }
  }

  // Przerwe wlaczamy dopiero, gdy ZADNA droga nie zadzialala - inaczej
  // zablokowalibysmy dzialajace pobieranie przez proxy. Przy cyklu co 10
  // minut ma to znaczenie takze wtedy, gdy padna same posrednicy: bez
  // przerwy kazdy cykl probowalby ich wszystkich po kolei.
  przerwaDo = Date.now() + PRZERWA_PO_BLOKADZIE_MS;

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

  // Artykuly siedza pod /aktualnosci/..., a komunikaty pod /komunikaty/... -
  // obie sekcje maja ten sam wzorzec adresu zakonczony "-iNNN".
  $('a[href*="/aktualnosci/"], a[href*="/komunikaty/"]').each((_, el) => {
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

  // Pusta lista ma DWIE rozne przyczyny i nie wolno ich mylic:
  //
  //   1. Strona sama informuje, ze nic nie ma ("Aktualnie brak komunikatow")
  //      - to normalny, poprawny stan. Zakladka Komunikaty MZK bywa pusta
  //        tygodniami i nie ma w tym nic niepokojacego.
  //   2. Strona cos zawiera, ale nic z niej nie wyciagnelismy - to dopiero
  //      jest podejrzane (zmiana ukladu strony, blokada, zly selektor).
  //
  // Wczesniej oba przypadki trafialy do logow jako ostrzezenie z podgladem
  // tresci, przez co pusta - czyli poprawnie dzialajaca - zakladka
  // wygladala na awarie przy kazdym cyklu. Alarm, ktory wlacza sie bez
  // powodu, przestaje cokolwiek znaczyc.
  if (!articles.length) {
    const tekst = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (STRONA_PUSTA_WZORZEC.test(tekst)) {
      console.log(`[mzk] ${pageUrl}: brak wpisow - strona sama informuje, ze nic nie ma (stan normalny)`);
    } else {
      console.warn(`[mzk] ${pageUrl}: 0 artykulow mimo tresci na stronie (HTTP ${status}, ${html.length} znakow). Poczatek tresci: "${tekst.slice(0, 200)}"`);
    }
  }
  return articles;
}

async function fetchMzk() {
  const results = [];

  // Przerwa po wykryciu blokady polaczenia - zeby nie marnowac ~50 sekund
  // kazdego cyklu na czekanie na wygasniecie limitow czasu.
  // WAZNE: przerwa dotyczy TYLKO polaczenia bezposredniego. Jesli jest
  // ustawiony serwer posredniczacy (MZK_PROXY_URL), pobieramy przez niego
  // normalnie w kazdym cyklu - on laczy sie inna droga, wiec blokada
  // naszego adresu IP go nie dotyczy.
  if (Date.now() < przerwaDo) {
    const zaIle = Math.ceil((przerwaDo - Date.now()) / 60000);
    console.warn(`[mzk] pomijam probe - polaczenie bylo blokowane, kolejna proba za ok. ${zaIle} min`);
    return results;
  }

  try {
    let articles = [];
    for (const pageUrl of PAGE_URLS) {
      try {
        articles = await fetchListing(pageUrl);
        if (articles.length) break; // udalo sie - nie probujemy kolejnego adresu
      } catch (err) {
        console.warn(`[mzk] ${err.message}`);
        // Blokada polaczenia dotyczy calego serwera, wiec proba kolejnego
        // adresu na tym samym serwerze nie ma sensu - tylko wydluzylaby cykl.
        if (toBladPolaczenia(err.message)) break;
      }
    }
    // Dodatkowo zakladka "Komunikaty" - nagle awarie i objazdy trafiaja
    // czesto wlasnie tam, a nie do "Aktualnosci". Bywa pusta i to jest
    // normalne, wiec jej brak nie jest bledem.
    try {
      const komunikaty = await fetchListing(KOMUNIKATY_URL);
      if (komunikaty.length) {
        console.log(`[mzk] zakladka Komunikaty: ${komunikaty.length} wpis(ow)`);
        const znane = new Set(articles.map((a) => a.href));
        for (const k of komunikaty) {
          if (!znane.has(k.href)) articles.push(k);
        }
      }
    } catch (err) {
      console.warn(`[mzk] zakladka Komunikaty niedostepna: ${err.message}`);
    }

    if (!articles.length) {
      console.error('[mzk] zaden z adresow nie zwrocil artykulow - sprawdz logi powyzej');
      return results;
    }

    const limited = articles.slice(0, 15);

    // Opis artykulu pobieramy TYLKO wtedy, gdy jeszcze go nie mamy.
    //
    // Wczesniej kazdy cykl pobieral osobno wszystkie 15 artykulow - takze
    // te sprzed miesiecy, ktorych tresc dawno jest w bazie i sie nie
    // zmienia. Przy cyklu co 10 minut dawalo to okolo 90 zadan na godzine
    // przez darmowego posrednika, co samo w sobie wywolywalo limity (HTTP
    // 408 i 429) i potrafilo wydluzyc cykl do ponad minuty. Teraz w
    // typowym cyklu nie pobieramy ani jednego artykulu - tylko te naprawde
    // nowe.
    //
    // Opis rowny tytulowi to wartosc zapasowa zapisana, gdy poprzednie
    // pobranie sie nie udalo - taki wpis probujemy pobrac jeszcze raz.
    let znaneOpisy = new Map();
    try {
      znaneOpisy = getDescriptionsByUrls(limited.map((a) => a.href));
    } catch (err) {
      // Brak dostepu do bazy nie moze zatrzymac scrapowania - w najgorszym
      // razie pobierzemy opisy tak jak dotad.
      console.warn('[mzk] nie udalo sie sprawdzic znanych opisow:', err.message);
    }

    let pobrane = 0;
    const descriptions = await Promise.all(
      limited.map((a) => {
        const zapisany = znaneOpisy.get(a.href);
        if (zapisany && zapisany !== a.title && zapisany.length > a.title.length) {
          return Promise.resolve(zapisany);
        }
        pobrane++;
        return fetchArticleDescription(a.href);
      })
    );
    if (pobrane) {
      console.log(`[mzk] pobieram opisy ${pobrane} z ${limited.length} artykulow (reszta juz w bazie)`);
    }

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
