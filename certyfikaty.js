// Dociaganie brakujacego ogniwa certyfikatu - to, co przegladarka robi sama.
//
// PROBLEM. Serwer gminy Zabor przysyla tylko swoj certyfikat
// (*.gminazabor.pl), a nie przysyla POSREDNIEGO, wystawionego przez
// "home pl DV TLS G2 R35 CA". Lancuch jest wiec niepelny i Node zrywa
// polaczenie z UNABLE_TO_VERIFY_LEAF_SIGNATURE. Przegladarka tego nie
// pokazuje, bo brakujace ogniwo dociaga sama - z adresu zapisanego
// w certyfikacie (pole AIA, "CA Issuers"). Node tego nie robi.
//
// CZEGO TU NIE MA. Nie ma wylaczenia weryfikacji. Mozna byloby "naprawic"
// Zabor jedna linia - rejectUnauthorized: false - i to jest dokladnie to,
// czego tu nie bedzie. Appka niesie mieszkancowi godzine, o ktorej zostanie
// wylaczona woda; gdyby ktos po drodze mogl podmienic te tresc, caly sens
// komunikatu znika. Zamiast tego dokladamy brakujace ogniwo i zostawiamy
// sprawdzanie WLACZONE.
//
// DLACZEGO MOZNA ZAUFAC DOCIAGNIETEMU OGNIWU. Pobieramy je po
// NIESZYFROWANYM http - bo tak podaje adres sam certyfikat - wiec samo
// pobranie niczego nie dowodzi. Dowodzi tego PODPIS: szukamy w sklepie
// glownych urzedow certyfikacji Node'a takiego, ktory naprawde podpisal
// dociagniete ogniwo. Jesli nie znajdziemy - odrzucamy je i zrodlo zostaje
// wylaczone. NIE MA sciezki awaryjnej w rodzaju "nie udalo sie sprawdzic,
// wiec polaczmy sie bez weryfikacji".
//
// POTWIERDZENIE Z SERWERA (sonda nr 10, 23.11.2026, Node v20.20.2):
//   adres AIA: http://homepldvtlsg2r35ca.repository.certum.pl/homepldvtlsg2r35ca.cer
//   pobrane:   1676 bajtow, typ application/pkix-cert
//   ogniwo:    C=PL, O=home.pl S.A., CN=home pl DV TLS G2 R35 CA
//   podpisal:  C=PL, O=Asseco Data Systems S.A., CN=Certum Trusted Root CA
//   zapytanie z rejectUnauthorized: true -> HTTP 200, 62264 zn.

const tls = require('tls');
const http = require('http');
const https = require('https');
const { X509Certificate } = require('crypto');

const LIMIT_CZASU_MS = 15000;
const MAX_PROB = 3;

// Po serii nieudanych prob odpoczywamy pol godziny i probujemy znowu.
//
// Bez tego jedna chwilowa awaria sieci wylaczalaby zrodlo AZ DO NASTEPNEGO
// WDROZENIA - a Render restartuje sie rzadko, wiec Zabor potrafilby milczec
// tygodniami przez pietnastosekundowy problem z DNS. Rozrozniamy wiec dwie
// rzeczy: niepowodzenie CHWILOWE (siec), po ktorym wracamy, i odmowe
// OSTATECZNA (zly podpis, brak adresu ogniwa, certyfikat po terminie),
// ktora jest decyzja i nie podlega ponowieniu.
const PRZERWA_PO_NIEPOWODZENIU_MS = 30 * 60 * 1000;

// host -> { pem } po sukcesie, { pem: null } gdy odrzucone OSTATECZNIE
const pamiec = new Map();
// host -> { prob, ostatnia } - wylacznie niepowodzenia chwilowe
const proby = new Map();

/**
 * Czyta certyfikat serwera, zeby dowiedziec sie, GDZIE lezy brakujace ogniwo.
 *
 * Tu i tylko tu weryfikacja jest wylaczona - inaczej nie dowiedzielibysmy sie
 * niczego, bo wlasnie ta weryfikacja zawodzi. Nie wysylamy zadnego zapytania
 * HTTP i nie pobieramy zadnej tresci: po odczytaniu certyfikatu gniazdo jest
 * zamykane. Odpowiada to dokladnie temu, co robi "openssl s_client".
 */
function odczytajAdresOgniwa(host) {
  return new Promise((resolve) => {
    let gniazdo;
    try {
      gniazdo = tls.connect({
        host,
        port: 443,
        servername: host,
        rejectUnauthorized: false, // wylacznie do ODCZYTU certyfikatu, patrz wyzej
        timeout: LIMIT_CZASU_MS,
      });
    } catch (err) {
      resolve({ blad: err.message });
      return;
    }

    gniazdo.on('secureConnect', () => {
      const cert = gniazdo.getPeerCertificate(true);
      gniazdo.destroy();

      const aia = (cert && cert.infoAccess) || {};
      const klucz = Object.keys(aia).find((k) => /CA Issuers/i.test(k));
      const adres = klucz ? (aia[klucz] || [])[0] : null;
      resolve({ adres: adres || null, wystawca: cert && cert.issuer ? cert.issuer.CN : null });
    });

    gniazdo.on('timeout', () => { gniazdo.destroy(); resolve({ blad: 'przekroczony czas' }); });
    gniazdo.on('error', (err) => resolve({ blad: err.message }));
  });
}

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
      odp.on('end', () => resolve(Buffer.concat(kawalki)));
    });
    zapytanie.on('timeout', () => { zapytanie.destroy(); reject(new Error('przekroczony czas')); });
    zapytanie.on('error', reject);
  });
}

const NAGLOWEK_PEM = '-----BEGIN CERTIFICATE-----';

/** Certyfikat przychodzi zwykle w postaci binarnej (DER) - zamieniamy na PEM. */
function naPem(bajty) {
  const jakoTekst = bajty.toString('utf8');
  if (jakoTekst.includes(NAGLOWEK_PEM)) return jakoTekst;
  const linie = bajty.toString('base64').match(/.{1,64}/g) || [];
  return `${NAGLOWEK_PEM}\n${linie.join('\n')}\n-----END CERTIFICATE-----\n`;
}

/**
 * Szuka w sklepie glownych urzedow certyfikacji takiego, ktory PODPISAL ten
 * certyfikat. Zwraca jego nazwe albo null.
 *
 * Sama zgodnosc nazw NIE wystarcza - nazwe moze sobie wpisac kazdy. Dlatego
 * po dopasowaniu wystawcy sprawdzamy jeszcze podpis kluczem publicznym
 * glownego urzedu. Dopiero to jest dowod.
 */
function ktoPodpisal(pem) {
  const posredni = new X509Certificate(pem);
  for (const rootPem of tls.rootCertificates) {
    let root;
    try {
      root = new X509Certificate(rootPem);
    } catch {
      continue; // uszkodzony wpis w sklepie nie moze przerwac przeszukiwania
    }
    if (root.subject !== posredni.issuer) continue;
    try {
      if (posredni.verify(root.publicKey)) return root.subject.replace(/\n/g, ', ');
    } catch {
      // Niezgodny typ klucza - to po prostu nie ten urzad.
    }
  }
  return null;
}

/** Czy certyfikat nadaje sie na ogniwo: jest urzedem i jest wazny dzisiaj. */
function sprawdzPrzydatnosc(pem, teraz = Date.now()) {
  const cert = new X509Certificate(pem);
  if (cert.ca === false) return 'pobrany certyfikat nie jest certyfikatem urzedu (CA)';
  const od = Date.parse(cert.validFrom);
  const doKiedy = Date.parse(cert.validTo);
  if (Number.isFinite(od) && teraz < od) return `ogniwo jeszcze nie obowiazuje (od ${cert.validFrom})`;
  if (Number.isFinite(doKiedy) && teraz > doKiedy) return `ogniwo straci waznosc (${cert.validTo})`;
  return null;
}

/**
 * Zwraca brakujace ogniwo dla hosta w postaci PEM albo null, gdy nie da sie
 * go wiarygodnie zdobyc. Wynik jest pamietany - certyfikaty urzedow zyja
 * latami, wiec pobieramy raz na uruchomienie serwera.
 *
 * null znaczy "nie wiem, czy to prawdziwe ogniwo" i jest ostateczne dla
 * wywolujacego: ma wtedy ZREZYGNOWAC z tego zrodla, a nie lagodzic warunkow.
 */
/**
 * Czy wolno teraz sprobowac. Po serii MAX_PROB niepowodzen CHWILOWYCH
 * czekamy pol godziny, a potem probujemy od nowa - zeby jeden problem
 * z siecia nie wylaczyl zrodla az do nastepnego wdrozenia.
 */
function czyMoznaProbowac(stan, teraz) {
  if (!stan || stan.prob < MAX_PROB) return true;
  return teraz - stan.ostatnia >= PRZERWA_PO_NIEPOWODZENIU_MS;
}

async function ogniwoDlaHosta(host, teraz = Date.now()) {
  if (pamiec.has(host)) return pamiec.get(host).pem;

  const stan = proby.get(host) || { prob: 0, ostatnia: 0 };
  if (!czyMoznaProbowac(stan, teraz)) return null;
  if (stan.prob >= MAX_PROB) {
    stan.prob = 0; // przerwa minela - zaczynamy nowa serie prob
    console.log(`[certyfikaty] ${host}: probuje ponownie po przerwie`);
  }
  stan.prob += 1;
  stan.ostatnia = teraz;
  proby.set(host, stan);

  const { adres, blad } = await odczytajAdresOgniwa(host);
  if (blad) {
    console.warn(`[certyfikaty] ${host}: nie udalo sie odczytac certyfikatu (${blad}), `
      + `proba ${stan.prob}/${MAX_PROB}`);
    return null;
  }
  if (!adres) {
    console.error(`[certyfikaty] ${host}: certyfikat nie podaje adresu brakujacego ogniwa `
      + '- tej drogi nie ma, trzeba poprosic gmine o poprawienie serwera');
    pamiec.set(host, { pem: null });
    return null;
  }

  let pem;
  try {
    pem = naPem(await pobierzBajty(adres));
  } catch (err) {
    console.warn(`[certyfikaty] ${host}: nie udalo sie pobrac ogniwa z ${adres} (${err.message}), `
      + `proba ${stan.prob}/${MAX_PROB}`);
    return null;
  }

  let podpisal;
  let przydatnosc;
  try {
    przydatnosc = sprawdzPrzydatnosc(pem);
    podpisal = ktoPodpisal(pem);
  } catch (err) {
    console.error(`[certyfikaty] ${host}: pobrany plik nie jest pojedynczym certyfikatem `
      + `(${err.message}) - ODRZUCAM`);
    pamiec.set(host, { pem: null });
    return null;
  }

  if (przydatnosc) {
    console.error(`[certyfikaty] ${host}: ${przydatnosc} - ODRZUCAM`);
    pamiec.set(host, { pem: null });
    return null;
  }

  if (!podpisal) {
    // Albo ktos podstawil nam certyfikat, albo wystawca nie jest w sklepie
    // zaufanych urzedow. W obu przypadkach nie wolno go uzyc.
    console.error(`[certyfikaty] ${host}: ogniwa pobranego z ${adres} NIE podpisal zaden `
      + 'zaufany glowny urzad certyfikacji - ODRZUCAM i rezygnuje z tego zrodla');
    pamiec.set(host, { pem: null });
    return null;
  }

  console.log(`[certyfikaty] ${host}: dociagnieto brakujace ogniwo, podpisal je ${podpisal} `
    + '- weryfikacja polaczenia zostaje wlaczona');
  pamiec.set(host, { pem });
  return pem;
}

/**
 * Pobiera strone z WLACZONA weryfikacja, dokladajac brakujace ogniwo obok
 * wszystkich normalnych urzedow certyfikacji. Obsluguje przekierowania.
 */
function pobierzZOgniwem(url, pem, naglowki, pozostaloPrzekierowan = 3) {
  return new Promise((resolve, reject) => {
    const zapytanie = https.get(url, {
      headers: naglowki,
      timeout: LIMIT_CZASU_MS,
      // SEDNO CALEGO MODULU: weryfikacja WLACZONA. Dokladamy wylacznie
      // brakujace ogniwo, ktorego serwer nie przysyla.
      rejectUnauthorized: true,
      ca: [...tls.rootCertificates, pem],
    }, (odp) => {
      const { statusCode } = odp;

      if (statusCode >= 300 && statusCode < 400 && odp.headers.location) {
        odp.resume();
        if (pozostaloPrzekierowan <= 0) {
          reject(new Error('zbyt wiele przekierowan'));
          return;
        }
        let dalej;
        try {
          dalej = new URL(odp.headers.location, url).href;
        } catch {
          reject(new Error('przekierowanie na bledny adres'));
          return;
        }
        pobierzZOgniwem(dalej, pem, naglowki, pozostaloPrzekierowan - 1)
          .then(resolve, reject);
        return;
      }

      if (statusCode !== 200) {
        odp.resume();
        reject(new Error(`HTTP ${statusCode}`));
        return;
      }

      const kawalki = [];
      odp.on('data', (k) => kawalki.push(k));
      odp.on('end', () => resolve({
        tekst: Buffer.concat(kawalki).toString('utf8'),
        koncowyUrl: url,
      }));
    });

    zapytanie.on('timeout', () => { zapytanie.destroy(); reject(new Error('przekroczony czas')); });
    zapytanie.on('error', reject);
  });
}

function zapomnij() {
  pamiec.clear();
  proby.clear();
}

module.exports = {
  ogniwoDlaHosta,
  czyMoznaProbowac,
  PRZERWA_PO_NIEPOWODZENIU_MS,
  pobierzZOgniwem,
  naPem,
  ktoPodpisal,
  sprawdzPrzydatnosc,
  zapomnij,
  NAGLOWEK_PEM,
  MAX_PROB,
};
