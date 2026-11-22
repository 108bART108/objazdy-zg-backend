// Sonda nr 3 - ostatnia. Uruchomienie:  node sonda3.js
//
// Zostala jedna niewiadoma: jak zbudowana jest PODSTRONA pojedynczego
// komunikatu PZZD. Lista z menu daje date, tytul i adres, ale tresc
// zawiadomienia (ktory odcinek, od kiedy do kiedy, ktoredy objazd) jest
// dopiero na podstronie. Bez jej ukladu pisalbym wyciaganie tresci po
// omacku - a dokladnie tak powstal blad, ktory przez miesiac ucinal
// komunikat MZK o ul. Zacisze.
//
// Dwa adresy, kilka sekund. Skrypt tylko czyta.

const LIMIT_CZASU_MS = 20000;
const ZNAKOW_TRESCI = 2600;
const ILE_ZALACZNIKOW = 5;

const NAGLOWKI = {
  'User-Agent': 'UtrudnieniaZG-sonda/1.0 (+info@utrudnienia-zg.pl)',
  'Accept': 'text/html,*/*;q=0.8',
  'Accept-Language': 'pl-PL,pl;q=0.9',
};

const CELE = [
  {
    nazwa: 'PZZD - podstrona komunikatu (najnowszy)',
    url: 'https://bip.pzzd.powiat-zielonogorski.pl/524/28_10_2026_Zamkniecie_drogi_powiatowej_nr_1181F/',
  },
  {
    nazwa: 'PZZD - podstrona komunikatu (starszy, dla porownania ukladu)',
    url: 'https://bip.pzzd.powiat-zielonogorski.pl/503/22_05_2026_Zamkniecie_drogi_powiatowej_1140F/',
  },
];

function zwin(tekst) {
  return String(tekst || '').replace(/\s+/g, ' ').trim();
}

async function sprawdz(cel) {
  console.log('');
  console.log('='.repeat(78));
  console.log(cel.nazwa);
  console.log(cel.url);
  console.log('-'.repeat(78));

  const kontroler = new AbortController();
  const stoper = setTimeout(() => kontroler.abort(), LIMIT_CZASU_MS);
  try {
    const odp = await fetch(cel.url, { headers: NAGLOWKI, signal: kontroler.signal, redirect: 'follow' });
    const html = await odp.text();
    console.log(`HTTP ${odp.status} | ${html.length} znakow`);
    if (!odp.ok) return;

    const tytul = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
    console.log(`tytul strony: ${tytul ? zwin(tytul[1]) : '(brak)'}`);

    // Gdzie zaczyna sie obszar tresci w tym silniku BIP
    for (const znacznik of ['class="information"', 'class="paragraph"', 'id="tresc"', 'class="content"']) {
      const jest = html.includes(znacznik);
      console.log(`${znacznik}: ${jest ? 'JEST' : 'brak'}`);
    }

    // Surowy kawalek obszaru tresci - to jest sedno tej sondy
    const start = html.indexOf('class="information"');
    const od = start > -1 ? start : html.indexOf('class="paragraph"');
    if (od > -1) {
      console.log('');
      console.log('--- SUROWY HTML obszaru tresci ---');
      console.log(zwin(html.substring(od, od + ZNAKOW_TRESCI)));
      console.log('--- koniec ---');
    } else {
      console.log('(nie znalazlem obszaru tresci - pokazuje srodek strony)');
      const srodek = Math.floor(html.length / 2);
      console.log(zwin(html.substring(srodek, srodek + ZNAKOW_TRESCI)));
    }

    // Czy sa zalaczniki (zawiadomienia bywaja PDF-ami)
    const pdfy = [...html.matchAll(/href="([^"]*(?:pobierz\.php|\.pdf)[^"]*)"/gi)].map((m) => m[1]);
    console.log('');
    console.log(`zalacznikow do pobrania: ${pdfy.length}`);
    for (const p of pdfy.slice(0, ILE_ZALACZNIKOW)) console.log(`   ${zwin(p)}`);
  } catch (err) {
    const powod = err.name === 'AbortError' ? `przekroczono ${LIMIT_CZASU_MS} ms` : err.message;
    console.log(`BLAD POBIERANIA: ${powod}`);
  } finally {
    clearTimeout(stoper);
  }
}

(async () => {
  console.log('SONDA 3 - uklad podstrony komunikatu PZZD');
  console.log(`data: ${new Date().toISOString()}`);
  for (const cel of CELE) {
    // eslint-disable-next-line no-await-in-loop
    await sprawdz(cel);
  }
  console.log('');
  console.log('='.repeat(78));
  console.log('KONIEC. Wklej calosc - zwlaszcza fragmenty surowego HTML.');
})();
