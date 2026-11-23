// Sonda nr 10 - Zabor. TYLKO DO CZYTANIA.
//     node sonda10.js
//
// Sonda nr 9 ustalila, co jest nie tak: serwer gminy Zabor przysyla tylko
// swoj certyfikat (*.gminazabor.pl), a nie przysyla POSREDNIEGO, wystawionego
// przez "home pl DV TLS G2 R35 CA". Przegladarka radzi sobie sama - dociaga
// brakujace ogniwo z adresu zapisanego w certyfikacie. Node tego nie robi
// i zrywa polaczenie z UNABLE_TO_VERIFY_LEAF_SIGNATURE.
//
// Ta sonda sprawdza, czy mozemy zrobic to samo, co przegladarka, NIE
// wylaczajac przy tym weryfikacji. Kolejno:
//
//   1. oglada lancuch i odczytuje z certyfikatu adres brakujacego ogniwa
//      (pole "CA Issuers" - tzw. AIA). Na tym jednym kroku weryfikacja jest
//      wylaczona, ale NIE POBIERAMY wtedy zadnej tresci strony - czytamy
//      wylacznie certyfikaty, tak jak "openssl s_client";
//   2. pobiera brakujace ogniwo z tego adresu;
//   3. SPRAWDZA JEGO PODPIS - szuka w sklepie glownych urzedow certyfikacji
//      Node'a takiego, ktory naprawde je podpisal. To jest sedno calej
//      sprawy: dociagniete ogniwo przyjmujemy tylko wtedy, gdy potwierdzi
//      je urzad, ktoremu system i tak ufa. Gdyby ktos podstawil nam swoje,
//      podpis sie nie zgodzi i odrzucimy je;
//   4. dopiero wtedy wykonuje PRAWDZIWE zapytanie o strone, z weryfikacja
//      WLACZONA (rejectUnauthorized: true) i dolozonym ogniwem;
//   5. jesli strona odpowie - oglada, skad brac z niej komunikaty: czy jest
//      kanal RSS, czy trzeba czytac HTML.
//
// Jesli krok 3 albo 4 nie przejdzie, nie wdrazamy tego rozwiazania.
// Alternatywa jest wtedy taka, ze poprosimy gmine o poprawienie serwera,
// a do tego czasu Zabor zostaje bez zrodla. Nie bedziemy wylaczac
// sprawdzania certyfikatu, zeby dowiezc komunikat o wodzie - mieszkaniec
// ma przeczytac godzine wylaczenia wody, a nie to, co ktos po drodze
// podmienil.

const tls = require('tls');
const https = require('https');
const http = require('http');
const { X509Certificate } = require('crypto');
const cheerio = require('cheerio');

const HOST = 'www.gminazabor.pl';
const LIMIT_CZASU_MS = 20000;
const DL_PODGLADU = 1200;
// Nazwana stala, a nie liczba w miejscu uzycia - inaczej kontrola obciec
// tresci slusznie zglasza kazde ".slice(0, 15)" jako ciche skrocenie.
const MAX_ODNOSNIKOW = 15;

const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG/1.0 (+https://utrudnienia-zg.pl; info@utrudnienia-zg.pl)',
  'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

function obetnij(t, ile) {
  const s = String(t || '');
  return s.length > ile ? `${s.substring(0, ile)}\n…[uciete, calosc ma ${s.length} zn.]` : s;
}

// ===================== 1. lancuch i adres brakujacego ogniwa ===============
function obejrzyjCertyfikat(host) {
  return new Promise((resolve) => {
    const gniazdo = tls.connect({
      host,
      port: 443,
      servername: host,
      // Tylko po to, zeby OBEJRZEC certyfikaty. Zadna tresc strony nie jest
      // tu pobierana - w kroku 4 weryfikacja jest juz wlaczona.
      rejectUnauthorized: false,
      timeout: LIMIT_CZASU_MS,
    });

    gniazdo.on('secureConnect', () => {
      const cert = gniazdo.getPeerCertificate(true);
      let ogniw = 0;
      let c = cert;
      const widziane = new Set();
      while (c && c.fingerprint && !widziane.has(c.fingerprint)) {
        widziane.add(c.fingerprint);
        ogniw += 1;
        c = c.issuerCertificate && c.issuerCertificate !== c ? c.issuerCertificate : null;
      }
      resolve({
        ok: true,
        podmiot: cert.subject ? (cert.subject.CN || '(brak)') : '(brak)',
        wystawca: cert.issuer ? (cert.issuer.CN || '(brak)') : '(brak)',
        waznyDo: cert.valid_to,
        ogniw,
        aia: cert.infoAccess || null,
      });
      gniazdo.end();
    });

    gniazdo.on('timeout', () => { gniazdo.destroy(); resolve({ ok: false, blad: 'przekroczony czas' }); });
    gniazdo.on('error', (e) => resolve({ ok: false, blad: e.message }));
  });
}

// ===================== 2. pobranie brakujacego ogniwa ======================
function pobierzBajty(url) {
  return new Promise((resolve, reject) => {
    const modul = url.startsWith('https:') ? https : http;
    const zapytanie = modul.get(url, { timeout: LIMIT_CZASU_MS }, (odp) => {
      if (odp.statusCode !== 200) {
        odp.resume();
        reject(new Error(`HTTP ${odp.statusCode}`));
        return;
      }
      const kawalki = [];
      odp.on('data', (k) => kawalki.push(k));
      odp.on('end', () => resolve({ bajty: Buffer.concat(kawalki), typ: odp.headers['content-type'] || '(brak)' }));
    });
    zapytanie.on('timeout', () => { zapytanie.destroy(); reject(new Error('przekroczony czas')); });
    zapytanie.on('error', reject);
  });
}

function derDoPem(bajty) {
  const linie = bajty.toString('base64').match(/.{1,64}/g) || [];
  return `-----BEGIN CERTIFICATE-----\n${linie.join('\n')}\n-----END CERTIFICATE-----\n`;
}

function naPem(bajty) {
  const jakoTekst = bajty.toString('utf8');
  if (jakoTekst.includes('-----BEGIN CERTIFICATE-----')) return jakoTekst;
  return derDoPem(bajty);
}

// ===================== 3. sprawdzenie podpisu ==============================
/**
 * Szuka w sklepie glownych urzedow certyfikacji Node'a takiego, ktory
 * PODPISAL dociagniete ogniwo. Bez tego kroku dokladalibysmy do zaufanych
 * certyfikat sciagniety z internetu, nie wiedzac, czy nie jest podstawiony.
 */
function ktoPodpisal(pem) {
  const posredni = new X509Certificate(pem);
  for (const rootPem of tls.rootCertificates) {
    try {
      const root = new X509Certificate(rootPem);
      if (root.subject !== posredni.issuer) continue;
      if (posredni.verify(root.publicKey)) return { root, posredni };
    } catch {
      // Uszkodzony wpis w sklepie nie moze przerwac przeszukiwania.
    }
  }
  return { root: null, posredni };
}

// ===================== 4. prawdziwe zapytanie, weryfikacja WLACZONA ========
function pobierzStrone(url, dodatkoweCa) {
  return new Promise((resolve, reject) => {
    const zapytanie = https.get(url, {
      headers: NAGLOWKI,
      timeout: LIMIT_CZASU_MS,
      // SEDNO: weryfikacja zostaje WLACZONA. Dokladamy tylko brakujace
      // ogniwo, ktorego serwer gminy nie przysyla, obok wszystkich
      // normalnych urzedow certyfikacji.
      rejectUnauthorized: true,
      ca: [...tls.rootCertificates, dodatkoweCa],
    }, (odp) => {
      const kawalki = [];
      odp.on('data', (k) => kawalki.push(k));
      odp.on('end', () => resolve({
        status: odp.statusCode,
        tekst: Buffer.concat(kawalki).toString('utf8'),
      }));
    });
    zapytanie.on('timeout', () => { zapytanie.destroy(); reject(new Error('przekroczony czas')); });
    zapytanie.on('error', reject);
  });
}

// ===================== 5. skad brac komunikaty =============================
function obejrzyjStrone(html, bazowyUrl) {
  const $ = cheerio.load(html);

  const kanaly = [];
  $('link[type*="rss"], link[type*="atom"], a[href*="rss"], a[href*="feed"]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const pelny = new URL(href, bazowyUrl).href;
      if (!kanaly.includes(pelny)) kanaly.push(pelny);
    } catch { /* adres bez sensu - pomijamy */ }
  });

  const generator = $('meta[name="generator"]').attr('content') || '(brak)';
  const tytul = $('title').first().text().replace(/\s+/g, ' ').trim();

  // Czy to ten sam CMS, co w Swidnicy i Otyniu? Jesli tak, parser mamy gotowy.
  const tenSamCms = /\/PL\/\d+\/\d+\/[^/]+\/k\/?/.test(html)
    || $('.information-header, .information-content-paragraph-first').length > 0;

  const odnosniki = [];
  $('a[href]').each((_, el) => {
    const href = $(el).attr('href') || '';
    let pelny;
    try { pelny = new URL(href, bazowyUrl).href; } catch { return; }
    if (!/aktualnosc|aktualno|news|komunikat|wiadomo|\/PL\/\d+\/\d+\//i.test(pelny)) return;
    const nazwa = ($(el).attr('title') || $(el).text()).replace(/\s+/g, ' ').trim();
    if (odnosniki.some((o) => o.url === pelny)) return;
    odnosniki.push({ url: pelny, nazwa });
  });

  return {
    tytul, generator, tenSamCms, kanaly, odnosniki,
  };
}

// ===================== przebieg ============================================
(async () => {
  console.log('SONDA 10 — Zabor: czy da sie naprawic certyfikat BEZ wylaczania weryfikacji');
  console.log(`Node ${process.version}`);
  console.log('');

  if (typeof X509Certificate !== 'function') {
    console.log('Ten Node nie udostepnia X509Certificate - nie sprawdze podpisu. Przerywam.');
    return;
  }

  // --- krok 1 ---
  console.log('--- KROK 1: lancuch i adres brakujacego ogniwa ---');
  const cert = await obejrzyjCertyfikat(HOST);
  if (!cert.ok) {
    console.log(`  nie udalo sie obejrzec certyfikatu: ${cert.blad}`);
    return;
  }
  console.log(`  certyfikat:  ${cert.podmiot}`);
  console.log(`  wystawca:    ${cert.wystawca}`);
  console.log(`  wazny do:    ${cert.waznyDo}`);
  console.log(`  ogniw od serwera: ${cert.ogniw} (potrzebne co najmniej 2)`);

  const aia = cert.aia || {};
  const klucz = Object.keys(aia).find((k) => /CA Issuers/i.test(k));
  const adresOgniwa = klucz ? (aia[klucz] || [])[0] : null;
  console.log(`  adres brakujacego ogniwa (AIA): ${adresOgniwa || 'BRAK W CERTYFIKACIE'}`);

  if (!adresOgniwa) {
    console.log('');
    console.log('  >>> Certyfikat nie podaje, gdzie szukac brakujacego ogniwa.');
    console.log('  >>> Tej drogi nie ma. Zostaje pismo do gminy o poprawienie serwera.');
    return;
  }

  // --- krok 2 ---
  console.log('');
  console.log('--- KROK 2: pobieram brakujace ogniwo ---');
  let pem;
  try {
    const plik = await pobierzBajty(adresOgniwa);
    console.log(`  pobrane: ${plik.bajty.length} bajtow, typ: ${plik.typ}`);
    pem = naPem(plik.bajty);
  } catch (e) {
    console.log(`  nie udalo sie pobrac: ${e.message}`);
    console.log('  >>> Jesli to blokada sieci Rendera, trzeba wkleic certyfikat recznie.');
    return;
  }

  // --- krok 3 ---
  console.log('');
  console.log('--- KROK 3: czy podpisal je prawdziwy glowny urzad certyfikacji ---');
  let podpis;
  try {
    podpis = ktoPodpisal(pem);
  } catch (e) {
    console.log(`  nie udalo sie odczytac pobranego pliku jako certyfikatu: ${e.message}`);
    console.log('  >>> Pewnie jest w formacie PKCS#7, nie pojedynczy certyfikat.');
    return;
  }

  console.log(`  pobrane ogniwo:  ${podpis.posredni.subject.replace(/\n/g, ' | ')}`);
  console.log(`  jego wystawca:   ${podpis.posredni.issuer.replace(/\n/g, ' | ')}`);
  console.log(`  wazne:           ${podpis.posredni.validFrom} → ${podpis.posredni.validTo}`);

  if (!podpis.root) {
    console.log('');
    console.log('  >>> ZADEN glowny urzad z zaufanego sklepu nie podpisal tego ogniwa.');
    console.log('  >>> NIE wolno go dokladac do zaufanych. Przerywam.');
    return;
  }
  console.log(`  PODPIS ZGODNY, podpisal: ${podpis.root.subject.replace(/\n/g, ' | ')}`);

  // --- krok 4 ---
  console.log('');
  console.log('--- KROK 4: prawdziwe zapytanie, weryfikacja WLACZONA ---');
  let strona;
  try {
    strona = await pobierzStrone(`https://${HOST}/`, pem);
    console.log(`  HTTP ${strona.status}, ${strona.tekst.length} zn. — polaczenie ZWERYFIKOWANE`);
  } catch (e) {
    console.log(`  nie udalo sie: ${e.message}`);
    console.log('  >>> Dolozenie ogniwa nie wystarczylo. Zostaje pismo do gminy.');
    return;
  }

  // --- krok 5 ---
  console.log('');
  console.log('--- KROK 5: skad brac komunikaty ---');
  const w = obejrzyjStrone(strona.tekst, `https://${HOST}/`);
  console.log(`  tytul strony: ${w.tytul}`);
  console.log(`  generator:    ${w.generator}`);
  console.log(`  ten sam CMS co Swidnica i Otyn: ${w.tenSamCms ? 'TAK - parser mamy gotowy' : 'nie'}`);
  console.log(`  kanaly RSS (${w.kanaly.length}):`);
  w.kanaly.forEach((k) => console.log(`      ${k}`));
  console.log(`  odnosniki wygladajace na komunikaty (${w.odnosniki.length}):`);
  w.odnosniki.slice(0, MAX_ODNOSNIKOW).forEach((o) => {
    console.log(`      ${o.nazwa || '(bez nazwy)'}`);
    console.log(`        ${o.url}`);
  });

  console.log('');
  console.log('  === PODGLAD POCZATKU STRONY ===');
  console.log(obetnij(strona.tekst.replace(/\s+/g, ' '), DL_PODGLADU));

  console.log('');
  console.log('KONIEC. Sonda nic nie zapisala i nic nie zmienila.');
})();
