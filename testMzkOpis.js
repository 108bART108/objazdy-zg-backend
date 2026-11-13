// Test wyciagania opisu z artykulu MZK.
// Uruchomienie:  node testMzkOpis.js
//
// Powstal, bo komunikat "Przywrocenie kursowania przez ul. Zacisze - od
// 19.10." przez miesiac wyswietlal sie w appce z opisem zaczynajacym sie od
// "w zwiazku z powyzszym nastapia zmiany..." - czyli od odwolania do zdania,
// ktorego czytelnik nigdy nie zobaczyl. Powod: dawny warunek "pierwszy
// akapit dluzszy niz 60 znakow" odrzucal otwierajace zdanie, bo mialo
// znakow 57. Tej logiki nie dalo sie wtedy sprawdzic bez wychodzenia do
// internetu, wiec blad przezyl kilka poprawek.

const { wyciagOpisZHtml } = require('./mzk');
const { scanTruncatedStart } = require('./sanitize');

// Uklad odwzorowany z https://www.mzk.zgora.pl/aktualnosci/
// przywrocenie-kursowania-przez-ul-zacisze-od-19-10-i1023
const ZACISZE = `
<html><body>
  <nav><a href="/">Strona główna</a> <a href="/aktualnosci">Aktualności</a></nav>
  <article>
    <h1>Przywrócenie kursowania przez ul. Zacisze - od 19.10.</h1>
    <span class="data">14.10.2026</span>
    <p>Informujemy, że od poniedziałku (<b>19 października</b>) nastąpi:</p>
    <ul>
      <li>przywrócenie ruchu dwukierunkowego na ul. Zacisze</li>
      <li>zamknięcie dla ruchu ulicy Działkowej na wysokości ulicy Różanej</li>
    </ul>
    <p>w związku z powyższym nastąpią zmiany w kursowaniu autobusów: przywrócone
       zostają stałe trasy linii nr 5, 10, 37 i N3 przez ul. Zacisze (w obu
       kierunkach), autobusy linii nr 26 będą kursowały wyłącznie do i z pętli
       Wyczółkowskiego.</p>
    <p>Linia nr 39 omija zamknięty odcinek ul. Działkowej, jadąc al. Wojska
       Polskiego i ul. Zacisze.</p>
  </article>
  <footer><p>Czytaj więcej</p></footer>
</body></html>`;

// Artykul zbudowany odwrotnie: dlugi akapit otwierajacy, bez listy.
const ZWYKLY = `
<html><body><article>
  <h1>Korekty w rozkładach jazdy</h1>
  <p>Informujemy, że od 1 października wprowadzone zostaną poniższe korekty w
     rozkładach jazdy wybranych linii autobusowych obsługiwanych przez nasz zakład.</p>
  <p>Linia nr 103 - minutowe korekty w kursach porannych.</p>
</article></body></html>`;

// Artykul, w ktorym przed trescia stoi komunikat o ciasteczkach i dane
// rejestrowe spolki - czyli to, co naprawde wylapuje BOILERPLATE_RE.
const Z_BOILERPLATE = `
<html><body><article>
  <h1>Zakończenie sezonu działkowego</h1>
  <p>Korzystając z naszego serwisu bez zmiany ustawień dotyczących cookies
     wyrażasz zgodę na ich zapisywanie w pamięci urządzenia.</p>
  <p>Miejski Zakład Komunikacji Spółka z ograniczoną odpowiedzialnością,
     NIP: 9290100412, REGON: 970315950.</p>
  <p>Miejski Zakład Komunikacji w Zielonej Górze informuje, że od wtorku,
     27 października 2026 r., w związku z zakończeniem sezonu działkowego,
     wprowadzone zostaną zmiany w kursowaniu linii nr 1 i 9.</p>
</article></body></html>`;

const PRZYPADKI = [
  {
    nazwa: 'ul. Zacisze - krotka zapowiedz + lista + szczegoly',
    html: ZACISZE,
    musiZaczynacSie: 'Informujemy, że od poniedziałku',
    musiZawierac: [
      'przywrócenie ruchu dwukierunkowego na ul. Zacisze',
      'zamknięcie dla ruchu ulicy Działkowej',
      'linii nr 5, 10, 37 i N3',
      'Linia nr 39',
    ],
  },
  {
    nazwa: 'zwykly artykul - dlugi akapit otwierajacy',
    html: ZWYKLY,
    musiZaczynacSie: 'Informujemy, że od 1 października',
    musiZawierac: ['Linia nr 103'],
  },
  {
    nazwa: 'pierwszy akapit to boilerplate - ma zostac pominiety',
    html: Z_BOILERPLATE,
    musiZaczynacSie: 'Miejski Zakład Komunikacji',
    musiZawierac: ['zakończeniem sezonu działkowego'],
  },
];

/**
 * Uruchamia wszystkie przypadki. Zwraca { sprawdzonych, bledy, podglad }.
 *
 * Funkcja NIE wypisuje niczego i NIE konczy procesu - wola ja takze
 * startupCheck.js przy starcie serwera, a tam process.exit() ubilby
 * backend zamiast zglosic problem. "podglad" sluzy tylko do wypisania
 * wyniku przy uruchomieniu z linii polecen.
 */
function uruchomTesty() {
  const bledy = [];
  const podglad = [];

  for (const p of PRZYPADKI) {
    const opis = wyciagOpisZHtml(p.html);

    if (!opis) {
      bledy.push(`${p.nazwa}: nie wyciagnieto zadnego opisu`);
      podglad.push({ nazwa: p.nazwa, opis: null });
      continue;
    }

    podglad.push({ nazwa: p.nazwa, opis });

    if (!opis.startsWith(p.musiZaczynacSie)) {
      bledy.push(`${p.nazwa}: opis ma sie zaczynac od "${p.musiZaczynacSie}"`);
    }

    for (const fragment of p.musiZawierac) {
      if (!opis.includes(fragment)) {
        bledy.push(`${p.nazwa}: brakuje fragmentu "${fragment}"`);
      }
    }

    // Kontrola krzyzowa: to, co wyciagniemy, nie moze byc zglaszane przez
    // sanitize jako uciety poczatek. Dokladnie ten sygnal zdradzil blad.
    const problemy = scanTruncatedStart(opis);
    if (problemy.length) {
      bledy.push(`${p.nazwa}: sanitize uznaje opis za uciety -> ${problemy.join('; ')}`);
    }

    // Stopka nie moze wejsc do opisu.
    if (/Czytaj więcej/i.test(opis)) {
      bledy.push(`${p.nazwa}: do opisu wszedl tekst stopki`);
    }
  }

  return { sprawdzonych: PRZYPADKI.length, bledy, podglad };
}

// Uruchomienie z linii polecen: node testMzkOpis.js
if (require.main === module) {
  const { sprawdzonych, bledy, podglad } = uruchomTesty();

  for (const p of podglad) {
    console.log(`--- ${p.nazwa}`);
    if (!p.opis) {
      console.log('    (nie wyciagnieto zadnego opisu)');
    } else {
      console.log(`    "${p.opis.slice(0, 110)}${p.opis.length > 110 ? '…' : ''}"`);
      console.log(`    dlugosc: ${p.opis.length}`);
    }
    console.log('');
  }

  for (const b of bledy) console.log(`BLAD ${b}`);
  console.log(`Sprawdzono ${sprawdzonych} artykulow, bledow: ${bledy.length}`);
  process.exit(bledy.length ? 1 : 0);
}

module.exports = { uruchomTesty };
