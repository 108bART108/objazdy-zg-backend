// Sonda nr 9 - dokończenie rozpoznania. TYLKO DO CZYTANIA.
//     node sonda9.js
//
// Sonda nr 8 odpowiedziała na jedno pytanie i potknęła się na dwóch.
//
// ZABÓR - odpowiedź jest: UNABLE_TO_VERIFY_LEAF_SIGNATURE na KAŻDYM adresie,
// także "http://" (bo strona przekierowuje na https). To znaczy, że serwer
// gminy nie wysyła certyfikatu POŚREDNIEGO. Przeglądarki radzą sobie z tym
// same - dociągają brakujące ogniwo z internetu albo mają je w pamięci -
// natomiast Node tego nie robi i zrywa połączenie. To NIE jest blokada
// adresu IP Rendera, jak sugerował mój wniosek w poprzedniej sondzie.
//
// Ta sonda OGLĄDA łańcuch certyfikatów, żeby ustalić, którego ogniwa brakuje.
// Łączy się z wyłączoną weryfikacją, ale NIE POBIERA ŻADNEJ TREŚCI - czyta
// wyłącznie certyfikaty, zamyka połączenie i tyle. To jest dokładnie to samo,
// co robi "openssl s_client", i NIE jest sposobem, w jaki będziemy pobierać
// dane. Docelowo dołożymy brakujące ogniwo do zaufanych, zostawiając
// weryfikację WŁĄCZONĄ - nigdy jej nie wyłączamy, bo wtedy każdy po drodze
// mógłby nam podmienić treść komunikatu o awarii.
//
// ŚWIDNICA I OTYŃ - sonda nr 8 weszła na ARCHIWUM (puste) zamiast na bieżące
// aktualności, a w tym CMS-ie odnośniki mają tekst "czytaj dalej", więc filtr
// po nazwie nie wyłapał niczego. Tu czytamy właściwą stronę i wyciągamy
// całe bloki wpisów: tytuł, datę i odnośnik razem.

const tls = require('tls');
const cheerio = require('cheerio');

const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'Accept': 'text/html,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const LIMIT_CZASU_MS = 20000;
const PAUZA_MS = 400;
const DL_UKLADU = 2500;
const DL_LINII = 160;
const MAX_LINII = 20;
const MAX_WPISOW = 10;

const SLOWA_WODA = /awari|przerw\w*\s+w\s+dostaw|brak\w*\s+wody|bez\s+wody|wodoci[ąa]g|wodomierz|uzdatnian|jako[śs][ćc]\s+wody|ska[żz]eni|kanaliz/i;

function skroc(t, ile) {
  const s = String(t || '').replace(/\s+/g, ' ').trim();
  return s.length > ile ? `${s.substring(0, ile)}…` : s;
}

function obetnij(t, ile) {
  const s = String(t || '');
  return s.length > ile ? `${s.substring(0, ile)}\n…[uciete, calosc ma ${s.length} zn.]` : s;
}

const odczekaj = (ms) => new Promise((r) => setTimeout(r, ms));

// ======================= 1. ZABÓR: łańcuch certyfikatów =====================
function obejrzyjCertyfikaty(host) {
  return new Promise((resolve) => {
    const gniazdo = tls.connect({
      host,
      port: 443,
      servername: host,
      // Wylacznie po to, zeby POLACZENIE doszlo do skutku i dalo sie
      // OBEJRZEC certyfikaty. Zadna tresc nie jest stad pobierana.
      rejectUnauthorized: false,
      timeout: LIMIT_CZASU_MS,
    });

    gniazdo.on('secureConnect', () => {
      const lancuch = [];
      let cert = gniazdo.getPeerCertificate(true);
      const widziane = new Set();
      while (cert && cert.subject && !widziane.has(cert.fingerprint)) {
        widziane.add(cert.fingerprint);
        lancuch.push({
          podmiot: cert.subject.CN || cert.subject.O || '(brak)',
          wystawca: cert.issuer ? (cert.issuer.CN || cert.issuer.O || '(brak)') : '(brak)',
          od: cert.valid_from,
          do: cert.valid_to,
          samopodpisany: cert.subject
            && cert.issuer
            && cert.subject.CN === cert.issuer.CN,
        });
        cert = cert.issuerCertificate && cert.issuerCertificate !== cert
          ? cert.issuerCertificate : null;
      }
      resolve({ ok: true, lancuch, autoryzowany: gniazdo.authorized, powod: gniazdo.authorizationError });
      gniazdo.end();
    });

    gniazdo.on('timeout', () => { gniazdo.destroy(); resolve({ ok: false, blad: 'przekroczony czas' }); });
    gniazdo.on('error', (e) => resolve({ ok: false, blad: e.message }));
  });
}

async function zbadajZabor() {
  console.log('');
  console.log('==========================================================');
  console.log('1. ZABÓR — czego brakuje w łańcuchu certyfikatów');
  console.log('==========================================================');
  console.log('(łączę się tylko po to, żeby obejrzeć certyfikaty — żadna treść');
  console.log(' nie jest pobierana; docelowo weryfikacja zostaje WŁĄCZONA)');
  console.log('');

  for (const host of ['www.gminazabor.pl', 'gminazabor.pl']) {
    const w = await obejrzyjCertyfikaty(host);
    console.log(`  ${host}`);
    if (!w.ok) {
      console.log(`    nie udalo sie polaczyc: ${w.blad}`);
      continue;
    }
    console.log(`    zaufany dla Node: ${w.autoryzowany ? 'TAK' : 'NIE'}`
      + `${w.powod ? ` (${w.powod})` : ''}`);
    console.log(`    ogniw w lancuchu przyslanych przez serwer: ${w.lancuch.length}`);
    w.lancuch.forEach((c, i) => {
      console.log(`      ${i + 1}. ${c.podmiot}`);
      console.log(`         wystawca: ${c.wystawca}`);
      console.log(`         wazny:    ${c.od} → ${c.do}`);
    });
    if (w.lancuch.length === 1) {
      console.log('    >>> SERWER PRZYSYLA TYLKO SWOJ CERTYFIKAT.');
      console.log(`    >>> Brakuje posredniego, wystawionego przez: ${w.lancuch[0].wystawca}`);
      console.log('    >>> To wlasnie dlatego Node odmawia polaczenia.');
    }
    console.log('');
    await odczekaj(PAUZA_MS);
  }
}

// ======================= 2. ŚWIDNICA I OTYŃ =================================
async function pobierz(url) {
  const kontroler = new AbortController();
  const stoper = setTimeout(() => kontroler.abort(), LIMIT_CZASU_MS);
  try {
    const odp = await fetch(url, { headers: NAGLOWKI, redirect: 'follow', signal: kontroler.signal });
    return { ok: odp.ok, status: odp.status, koncowyUrl: odp.url, tekst: await odp.text() };
  } finally {
    clearTimeout(stoper);
  }
}

/**
 * Wyciaga bloki wpisow z listy aktualnosci. W tym CMS-ie odnosnik ma tekst
 * "czytaj dalej" albo jest obrazkiem, a TYTUL stoi obok - dlatego nie
 * patrzymy na tekst odnosnika, tylko na jego atrybut "title" i na naglowek
 * w tym samym bloku.
 */
function wyciagWpisy($, bazowyUrl) {
  const wpisy = [];
  $('a[href]').each((_, el) => {
    const $a = $(el);
    const href = $a.attr('href') || '';
    let pelny;
    try { pelny = new URL(href, bazowyUrl).href; } catch { return; }
    // Pozycja tresci w tym CMS-ie: /PL/<liczba>/<id>/<nazwa>/k/
    if (!/\/PL\/\d+\/\d+\/[^/]+\/k\/?$/.test(pelny)) return;
    if (wpisy.some((w) => w.url === pelny)) return;

    // Tytul: najpierw atrybut "title" odnosnika (CMS wpisuje tam pelna nazwe),
    // potem naglowek w otaczajacym bloku, na koncu sam tekst odnosnika.
    const zTitle = ($a.attr('title') || '').replace(/^Przejd[źz] do informacji:\s*/i, '').trim();
    const blok = $a.closest('.owl-content, .news-box-item, .information, li, div');
    const zNaglowka = skroc(blok.find('h2, h3, h4').first().text(), DL_LINII);
    const zTekstu = skroc($a.text(), DL_LINII);
    const tytul = zTitle || zNaglowka || zTekstu;

    const data = skroc(blok.find('.date, .clock, .phx').first().text(), 40);
    if (!tytul || tytul.length < 6) return;
    wpisy.push({ tytul, data, url: pelny, oWodzie: SLOWA_WODA.test(tytul) });
  });
  return wpisy;
}

const POJEMNIKI = ['.paragraph', '.information', '.content-main', '#content', '.content', 'article', 'main'];

async function pokazPodstrone(url, etykieta) {
  console.log('');
  console.log(`  --- PODSTRONA: ${etykieta}`);
  console.log(`      ${url}`);
  let odp;
  try { odp = await pobierz(url); } catch (e) { console.log(`      BLAD: ${e.message}`); return; }
  console.log(`      HTTP ${odp.status} | ${odp.tekst.length} zn.`);
  if (!odp.ok) return;

  const $ = cheerio.load(odp.tekst);
  $('script, style, nav, header, footer, #rightMenu, .menu-left-wrapper, .sidebar').remove();

  const zmierzone = POJEMNIKI
    .map((sel) => ({ sel, el: $(sel).first(), dl: $(sel).first().text().replace(/\s+/g, ' ').trim().length }))
    .filter((p) => p.el.length)
    .sort((a, b) => b.dl - a.dl);

  console.log('');
  console.log('      === POJEMNIKI ===');
  zmierzone.forEach((p) => console.log(`      ${p.sel.padEnd(16)} ${p.dl} zn.`));
  if (!zmierzone.length) { console.log('      brak typowych pojemnikow'); return; }

  console.log('');
  console.log(`      === UKLAD (${zmierzone[0].sel}) ===`);
  console.log(obetnij(zmierzone[0].el.html(), DL_UKLADU));

  console.log('');
  console.log('      === TEKST ===');
  const linie = [];
  zmierzone[0].el.find('p, div, li, td, h1, h2, h3, h4, span').each((_, el) => {
    const $el = $(el);
    if ($el.children('p, div, li, td').length) return;
    const t = skroc($el.text(), DL_LINII);
    if (t && t.length > 2 && !linie.includes(t)) linie.push(t);
  });
  linie.slice(0, MAX_LINII).forEach((l, i) => {
    console.log(`      ${String(i + 1).padStart(2)}. ${l}${/:$/.test(l) ? '   <<< DWUKROPEK' : ''}`);
  });
  if (linie.length > MAX_LINII) console.log(`      … i jeszcze ${linie.length - MAX_LINII} linii`);
}

async function zbadajGmine(nazwa, adresy) {
  console.log('');
  console.log('==========================================================');
  console.log(nazwa);
  console.log('==========================================================');

  let najlepsza = null;
  for (const url of adresy) {
    await odczekaj(PAUZA_MS);
    let w;
    try { w = await pobierz(url); } catch (e) { console.log(`  BLAD  ${url} — ${e.message}`); continue; }
    if (!w.ok) { console.log(`  HTTP ${w.status}  ${url}`); continue; }
    const wpisy = wyciagWpisy(cheerio.load(w.tekst), w.koncowyUrl);
    console.log(`  OK    ${url}  →  ${wpisy.length} wpisow`);
    if (!najlepsza || wpisy.length > najlepsza.wpisy.length) najlepsza = { url, wpisy, w };
  }

  if (!najlepsza || !najlepsza.wpisy.length) {
    console.log('  Zadna strona nie dala wpisow - CMS moze doladowywac je skryptem.');
    return;
  }

  const { wpisy } = najlepsza;
  const oWodzie = wpisy.filter((x) => x.oWodzie);
  console.log('');
  console.log(`  Pracuje na: ${najlepsza.url}`);
  console.log(`  === WPISY: ${wpisy.length}, o wodzie: ${oWodzie.length} ===`);
  wpisy.slice(0, MAX_WPISOW).forEach((x) => {
    console.log(`  ${x.oWodzie ? '[WODA]' : '      '} ${x.data ? `${x.data}  ` : ''}${x.tytul}`);
    console.log(`         ${x.url}`);
  });

  const cel = oWodzie[0] || wpisy[0];
  await odczekaj(PAUZA_MS);
  await pokazPodstrone(cel.url, cel.oWodzie ? `o wodzie: ${cel.tytul}` : `dowolny: ${cel.tytul}`);
}

(async () => {
  console.log('SONDA 9 — dokonczenie rozpoznania (tylko czytanie)');

  await zbadajZabor();

  await zbadajGmine('2. ŚWIDNICA — bieżące aktualności', [
    'https://swidnica.zgora.pl/',
    'https://swidnica.zgora.pl/PL/1000/News_box/',
  ]);

  await zbadajGmine('3. OTYŃ — bieżące aktualności', [
    'http://www.otyn.pl/',
    'http://www.otyn.pl/PL/1000/News_box/',
    'http://www.otyn.pl/PL/1000/1/archiwum/News_box/',
  ]);

  console.log('');
  console.log('KONIEC. Sonda nic nie zapisala i nic nie zmienila.');
})();
