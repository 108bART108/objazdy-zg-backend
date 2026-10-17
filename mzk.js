const cheerio = require('cheerio');
const { extractStreet } = require('./classify');

const PAGE_URL = 'https://www.mzk.zgora.pl/aktualnosci';
const HEADERS = { 'User-Agent': 'ObjazdyZG-bot/1.0 (+kontakt@twoja-domena.pl)' };

// Teksty nawigacyjne i stopkowe, ktore nie sa trescia komunikatu.
const NOISE_RE = /^(menu|aktualnosci|aktualności|rozk[lł]ady|rozk[lł]ad jazdy|kontakt|strona g[lł][oó]wna|czytaj wi[eę]cej|wi[eę]cej|wstecz|powr[oó]t|bilety|cennik|szukaj|galeria|archiwum|polityka|cookies|deklaracja|mapa strony|bip|o nas|przetargi|praca)\b/i;

// Buduje opis komunikatu z CALEJ tresci artykulu, w kolejnosci wystepowania.
//
// Poprzednia wersja brala pierwszy akapit dluzszy niz 60 znakow i na tym
// konczyla. Komunikaty MZK maja jednak uklad: krotki wstep ("Informujemy, ze
// od poniedzialku (19 pazdziernika) nastapi:"), potem lista punktow, potem
// dalszy ciag zdania. Wstep bywa krotszy niz 60 znakow, a punkty listy to
// <li>, nie <p> - przez to opis zaczynal sie w polowie mysli, od slow
// "w zwiazku z powyzszym", chociaz zadnego "powyzszego" czytelnik nie widzial.
function extractArticleText($) {
  // Usuwamy nawigacje i stopke, zeby pozycje menu (zwykle <li>) nie trafily
  // do opisu.
  $('nav, header, footer, aside, script, style, form, noscript').remove();
  $('[class*="menu"], [class*="nav"], [id*="menu"], [id*="nav"], [class*="footer"], [class*="stopka"], [class*="breadcrumb"]').remove();

  // Kontener tresci: wybieramy ten, ktory zawiera najwiecej tekstu.
  // Nie zakladamy konkretnej nazwy klasy, bo strona zrodlowa moze ja zmienic.
  let best = null;
  let bestLen = 0;
  $('article, main, [class*="content"], [class*="article"], [class*="news"], [class*="tresc"], [class*="post"], [id*="content"], [id*="tresc"]')
    .each((_, el) => {
      const len = $(el).find('p, li').text().replace(/\s+/g, ' ').trim().length;
      if (len > bestLen) { bestLen = len; best = el; }
    });
  const scope = best ? $(best) : $('body');

  const parts = [];
  const seen = new Set();

  scope.find('p, li').each((_, el) => {
    const $el = $(el);
    // Pomijamy kontenery zawierajace kolejne p/li - inaczej ten sam tekst
    // trafilby do opisu dwa razy (raz z rodzica, raz z dziecka).
    if ($el.find('p, li').length) return;

    const text = $el.text().replace(/\s+/g, ' ').trim();
    if (text.length < 8) return;
    if (NOISE_RE.test(text)) return;
    // Krotki element bedacy w calosci linkiem to prawie na pewno nawigacja.
    if (text.length < 40 && $el.find('a').length && $el.find('a').text().trim().length >= text.length - 2) return;

    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);

    parts.push({ tag: (el.tagName || el.name || '').toLowerCase(), text });
  });

  if (!parts.length) return null;

  // Sklejanie z zachowaniem sensu zdania.
  let out = parts[0].text;
  for (let i = 1; i < parts.length; i += 1) {
    const { tag, text } = parts[i];
    const endsOpen = /[:;,]$/.test(out);

    if (tag === 'li') {
      out += endsOpen ? ` ${text}` : `; ${text}`;
    } else if (/^[a-ząćęłńóśźż]/.test(text)) {
      // Akapit zaczynajacy sie mala litera to dalszy ciag zdania przerwanego
      // lista - laczymy przecinkiem, nie kropka, zeby nie tworzyc zdania
      // rozpoczynajacego sie od malej litery.
      out = out.replace(/[.;]\s*$/, '');
      out += /,$/.test(out) ? ` ${text}` : `, ${text}`;
    } else {
      out += /[.!?:;]$/.test(out) ? ` ${text}` : `. ${text}`;
    }
  }

  return out;
}

// Przycina opis do limitu, ale na granicy zdania lub punktu listy,
// zeby nie urywac w polowie slowa.
function trimDescription(text, limit = 600) {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastStop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('; '));
  if (lastStop > limit * 0.5) return cut.slice(0, lastStop + 1).trim();
  const lastSpace = cut.lastIndexOf(' ');
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : limit).trim()}...`;
}

async function fetchArticleDescription(url) {
  try {
    const res = await fetch(url, { headers: HEADERS });
    if (!res.ok) return null;
    const html = await res.text();
    const $ = cheerio.load(html);
    const text = extractArticleText($);
    return text ? trimDescription(text) : null;
  } catch (err) {
    console.error(`[mzk] blad pobierania opisu artykulu (${url}):`, err.message);
    return null;
  }
}

async function fetchMzk() {
  const results = [];
  try {
    const res = await fetch(PAGE_URL, { headers: HEADERS });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    const $ = cheerio.load(html);
    const base = new URL(PAGE_URL).origin;
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

    const limited = articles.slice(0, 15);
    const descriptions = await Promise.all(
      limited.map((a) => fetchArticleDescription(a.href))
    );

    limited.forEach((a, i) => {
      const description = descriptions[i] || a.title;
      results.push({
        source_url: a.href,
        source_name: 'MZK Zielona Gora',
        category: 'mzk',
        title: a.title,
        street: extractStreet(description) || extractStreet(a.title),
        description,
        published_at: a.publishedAt,
      });
    });
  } catch (err) {
    console.error('[mzk] blad pobierania:', err.message);
  }
  return results;
}

module.exports = { fetchMzk };
