// Testy dociagania brakujacego ogniwa certyfikatu.
//
// Testujemy na PRAWDZIWYCH certyfikatach - tych ze sklepu glownych urzedow
// certyfikacji wbudowanego w Node. Nie potrzeba do tego sieci ani zadnych
// wymyslonych danych, a sprawdzamy dokladnie to, od czego zalezy
// bezpieczenstwo: czy podpis naprawde jest weryfikowany, czy tylko
// porownujemy nazwy.
//
// To rozroznienie jest tu calym sednem. Nazwe wystawcy moze sobie wpisac
// kazdy - gdyby modul poprzestawal na zgodnosci nazw, wystarczyloby podstawic
// certyfikat z napisem "Certum Trusted Root CA", zeby appka przyjela cudze
// ogniwo i zaczela ufac podmienionym komunikatom o awariach wody.

const tls = require('tls');
const { X509Certificate } = require('crypto');
const {
  naPem, ktoPodpisal, sprawdzPrzydatnosc, czyMoznaProbowac,
  NAGLOWEK_PEM, MAX_PROB, PRZERWA_PO_NIEPOWODZENIU_MS,
} = require('./certyfikaty');

const bledy = [];
let sprawdzonych = 0;

function sprawdz(opis, warunek) {
  sprawdzonych += 1;
  if (!warunek) bledy.push(opis);
}

function rowne(opis, mam, oczekuje) {
  sprawdzonych += 1;
  if (mam !== oczekuje) bledy.push(`${opis} - jest "${mam}", powinno byc "${oczekuje}"`);
}

/** Pierwszy glowny urzad ze sklepu, ktory sam siebie podpisal. */
function znajdzGlownyUrzad() {
  for (const pem of tls.rootCertificates) {
    try {
      const cert = new X509Certificate(pem);
      if (cert.subject !== cert.issuer) continue;
      if (!cert.verify(cert.publicKey)) continue;
      return { pem, cert };
    } catch {
      // Uszkodzony wpis w sklepie pomijamy.
    }
  }
  return null;
}

function testPem() {
  const urzad = znajdzGlownyUrzad();
  sprawdz('w sklepie Node jest przynajmniej jeden glowny urzad certyfikacji',
    Boolean(urzad));
  if (!urzad) return null;

  // Certyfikat przychodzi z serwera w postaci binarnej (DER) - tak bylo
  // w sondzie nr 10: 1676 bajtow, typ application/pkix-cert.
  const der = urzad.cert.raw;
  const zDer = naPem(der);
  sprawdz('z postaci binarnej powstaje PEM', zDer.startsWith(NAGLOWEK_PEM));
  sprawdz('PEM z postaci binarnej konczy sie poprawnie',
    zDer.trim().endsWith('-----END CERTIFICATE-----'));

  let odtworzony = null;
  try {
    odtworzony = new X509Certificate(zDer);
  } catch (err) {
    bledy.push(`PEM z postaci binarnej nie daje sie odczytac (${err.message})`);
  }
  sprawdzonych += 1;
  if (odtworzony) {
    rowne('przetworzony certyfikat to wciaz ten sam podmiot',
      odtworzony.subject, urzad.cert.subject);
  }

  // Gdy serwer odda od razu PEM, nie wolno go pakowac drugi raz.
  const zPem = naPem(Buffer.from(urzad.pem, 'utf8'));
  rowne('PEM podany wprost nie jest pakowany drugi raz',
    (zPem.match(/BEGIN CERTIFICATE/g) || []).length, 1);

  return urzad;
}

function testPodpis(urzad) {
  if (!urzad) return;

  // Glowny urzad podpisal sam siebie, wiec funkcja musi go znalezc.
  const podpisal = ktoPodpisal(urzad.pem);
  sprawdz('podpis prawdziwego certyfikatu zostaje potwierdzony', Boolean(podpisal));

  // NAJWAZNIEJSZE: znaleziony urzad to ten, ktory NAPRAWDE podpisal, a nie
  // dowolny inny ze sklepu. Gdyby funkcja poprzestawala na porownaniu nazw
  // albo zwracala pierwszy lepszy wpis, ten warunek by nie przeszedl.
  if (podpisal) {
    rowne('znaleziony urzad to ten, ktory naprawde podpisal',
      podpisal, urzad.cert.issuer.replace(/\n/g, ', '));
  }

  // Certyfikat, ktorego wystawcy NIE MA w sklepie, musi zostac odrzucony.
  // Budujemy go z prawdziwego certyfikatu, podmieniajac jeden bajt w czesci
  // podpisanej - nazwa wystawcy zostaje ta sama, wiec dopasowanie po nazwie
  // nadal trafi, ale podpis juz sie nie zgodzi.
  const popsuty = Buffer.from(urzad.cert.raw);
  popsuty[popsuty.length - 1] ^= 0xff;
  let wynikPopsutego;
  try {
    wynikPopsutego = ktoPodpisal(naPem(popsuty));
  } catch {
    wynikPopsutego = null; // nie da sie nawet odczytac - tez dobrze
  }
  rowne('certyfikat z podmienionym podpisem zostaje ODRZUCONY', wynikPopsutego, null);
}

function testPrzydatnosc(urzad) {
  if (!urzad) return;

  rowne('wazny glowny urzad przechodzi kontrole przydatnosci',
    sprawdzPrzydatnosc(urzad.pem), null);

  // Certyfikaty urzedow zyja latami, ale nie wiecznie - ten z Zaboru traci
  // waznosc w 2035 roku. Gdy to nastapi, modul ma odmowic, a nie milczec.
  const za100lat = Date.now() + 100 * 365 * 86400000;
  const wynik = sprawdzPrzydatnosc(urzad.pem, za100lat);
  sprawdz('przeterminowane ogniwo zostaje odrzucone z wyjasnieniem',
    typeof wynik === 'string' && /waznos|waznoś/i.test(wynik));

  const przed = Date.parse(urzad.cert.validFrom) - 86400000;
  const wynikPrzed = sprawdzPrzydatnosc(urzad.pem, przed);
  sprawdz('ogniwo jeszcze nieobowiazujace zostaje odrzucone',
    typeof wynikPrzed === 'string' && /nie obowiazuje/i.test(wynikPrzed));
}

function testSmieci() {
  // Pobrany plik moze byc czymkolwiek - modul ma rzucic wyjatkiem,
  // ktory wywolujacy przechwytuje i odrzuca zrodlo.
  let rzucilo = false;
  try {
    ktoPodpisal('to nie jest zaden certyfikat');
  } catch {
    rzucilo = true;
  }
  sprawdz('smieci zamiast certyfikatu powoduja wyjatek, a nie ciche przyjecie', rzucilo);

  let rzuciloPrzydatnosc = false;
  try {
    sprawdzPrzydatnosc('rowniez nie certyfikat');
  } catch {
    rzuciloPrzydatnosc = true;
  }
  sprawdz('kontrola przydatnosci tez odrzuca smieci', rzuciloPrzydatnosc);
}

function testPonawianie() {
  const teraz = Date.now();

  sprawdz('pierwsza proba jest dozwolona', czyMoznaProbowac(null, teraz));
  sprawdz('kolejna proba przed wyczerpaniem limitu jest dozwolona',
    czyMoznaProbowac({ prob: MAX_PROB - 1, ostatnia: teraz }, teraz));

  sprawdz('po wyczerpaniu limitu nie probujemy od razu',
    !czyMoznaProbowac({ prob: MAX_PROB, ostatnia: teraz }, teraz));

  // To jest sedno: chwilowa awaria sieci NIE moze wylaczyc zrodla az do
  // nastepnego wdrozenia. Render restartuje sie rzadko, wiec bez tego Zabor
  // milczalby tygodniami przez pietnastosekundowy problem z DNS.
  sprawdz('po przerwie probujemy znowu',
    czyMoznaProbowac(
      { prob: MAX_PROB, ostatnia: teraz - PRZERWA_PO_NIEPOWODZENIU_MS - 1000 },
      teraz,
    ));

  sprawdz('tuz przed koncem przerwy jeszcze nie probujemy',
    !czyMoznaProbowac(
      { prob: MAX_PROB, ostatnia: teraz - PRZERWA_PO_NIEPOWODZENIU_MS + 1000 },
      teraz,
    ));
}

function uruchomTesty() {
  bledy.length = 0;
  sprawdzonych = 0;
  const urzad = testPem();
  testPodpis(urzad);
  testPrzydatnosc(urzad);
  testSmieci();
  testPonawianie();
  return { sprawdzonych, bledy };
}

if (require.main === module) {
  const wynik = uruchomTesty();
  for (const b of wynik.bledy) console.error(`  BLAD: ${b}`);
  console.log(`Sprawdzono ${wynik.sprawdzonych} warunkow, bledow: ${wynik.bledy.length}`);
  if (wynik.bledy.length) process.exitCode = 1;
}

module.exports = { uruchomTesty };
