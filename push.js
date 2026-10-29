const webpush = require('web-push');
const { getAllSubscriptions, deleteSubscription } = require('./db');

// Adres, ktory otwiera sie po klknieciu w powiadomienie. MUSI byc tym
// samym adresem, pod ktorym dziala appka zainstalowana z Google Play -
// inaczej klikniecie otwiera przegladarke zamiast appki, bo system widzi
// inna domene niz ta z assetlinks.json.
const APP_URL = process.env.APP_URL || 'https://utrudnienia-zg.pl';

// Adres kontaktowy wymagany przez dostawcow push (Google, Apple) - trafia
// do nich w naglowku, zeby mieli sie z kim skontaktowac przy problemach.
const VAPID_CONTACT = process.env.VAPID_CONTACT || 'mailto:info@utrudnienia-zg.pl';

const CATEGORY_LABELS = {
  drogi: 'Drogi',
  mzk: 'MZK',
  wodociagi: 'Wodociągi',
  prad: 'Prąd',
};

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(VAPID_CONTACT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

// Wysyla powiadomienia push do subskrybentow, ktorych wybrane kategorie
// pokrywaja sie z kategoriami nowych wpisow. Pusta lista kategorii w
// subskrypcji oznacza "wszystkie kategorie".
//
// WAZNE: klikniecie w powiadomienie otwiera APPKE (z automatycznie
// wybrana wlasciwa kategoria), a NIE bezposrednio zewnetrzna strone
// zrodlowa - to celowe, zeby uzytkownik najpierw zobaczyl skrocona
// informacje w appce, a dopiero jesli zechce, sam kliknie w tytul
// wpisu, zeby przejsc do pelnego artykulu na stronie zrodlowej.
async function notifySubscribers(newItems) {
  if (!newItems || !newItems.length) return { dostarczono: 0, bledow: 0, pominietoKategorie: 0 };
  if (!ensureConfigured()) {
    console.warn('[push] brak kluczy VAPID w zmiennych srodowiskowych - pomijam wysylke');
    return { dostarczono: 0, bledow: 0, pominietoKategorie: 0, powod: 'brak kluczy VAPID' };
  }

  const subs = getAllSubscriptions();
  console.log(`[push] ${newItems.length} nowych wpisow, ${subs.length} zarejestrowanych subskrybentow`);
  if (!subs.length) return { dostarczono: 0, bledow: 0, pominietoKategorie: 0, powod: 'brak subskrybentow' };

  let sent = 0;
  let bledow = 0;
  let pominietePrzezKategorie = 0;
  for (const sub of subs) {
    const prefCategories = sub.categories ? sub.categories.split(',').filter(Boolean) : [];
    const matched = newItems.filter(
      (i) => prefCategories.length === 0 || prefCategories.includes(i.category)
    );
    if (!matched.length) {
      // Subskrybent nie wybral kategorii, ktorej dotyczy ten wpis - to
      // normalne, ale warto wiedziec, ilu osob to dotyczy. Bez tego
      // "wyslano 2/12" wyglada jak awaria, a jest poprawnym dzialaniem.
      pominietePrzezKategorie++;
      continue;
    }

    const first = matched[0];
    // Etykieta kategorii w tytule powiadomienia - jesli wszystkie pasujace
    // wpisy sa z jednej kategorii, pokazujemy jej nazwe; jesli to mieszanka
    // kilku kategorii naraz, laczymy je znakiem "+".
    const distinctCategories = [...new Set(matched.map((m) => m.category))];
    const categoryLabel = distinctCategories
      .map((c) => CATEGORY_LABELS[c] || c)
      .join(' + ');

    const title = matched.length === 1
      ? `${categoryLabel}: ${first.street || first.title}`
      : `${categoryLabel} — nowe utrudnienia (${matched.length})`;
    const body = matched.length === 1
      ? (first.description || '').slice(0, 120)
      : matched.map((m) => m.street || m.title).slice(0, 3).join(', ');

    // Link prowadzi do appki, do konkretnej kategorii - NIE do zewnetrznej
    // strony zrodlowej. Jesli powiadomienie dotyczy kilku roznych kategorii
    // naraz, otwieramy widok "Drogi" jako domyslny (najczesciej uzywany).
    const targetCategory = first.category || 'drogi';
    const url = `${APP_URL}/?filter=${encodeURIComponent(targetCategory)}`;

    const payload = JSON.stringify({ title, body, url });

    try {
      await webpush.sendNotification(JSON.parse(sub.subscription_json), payload);
      sent++;
    } catch (err) {
      bledow++;
      console.error(`[push] blad wysylki (${sub.endpoint.slice(0, 40)}...):`, err.statusCode || err.message);
      if (err.statusCode === 404 || err.statusCode === 410) {
        deleteSubscription(sub.endpoint);
      }
    }
  }
  const opisPominietych = pominietePrzezKategorie
    ? `, pominieto ${pominietePrzezKategorie} (inne wybrane kategorie)`
    : '';
  console.log(`[push] wyslano ${sent}/${subs.length} powiadomien${opisPominietych}`);
  return { dostarczono: sent, bledow, pominietoKategorie: pominietePrzezKategorie };
}

// Testowe powiadomienie do WSZYSTKICH zapisanych urzadzen, z pominieciem
// filtra kategorii. To wazne: zwykla wysylka omija osoby, ktore nie
// wybraly danej kategorii, wiec test oparty na notifySubscribers moglby
// falszywie sugerowac awarie u kogos, kto po prostu nie subskrybuje
// kategorii uzytej w tescie.
// Zwraca raport per urzadzenie - bez pelnych adresow (to identyfikatory
// konkretnych urzadzen), tylko dostawca i koncowka.
async function sendTestNotification() {
  if (!ensureConfigured()) {
    throw new Error('brak kluczy VAPID w zmiennych srodowiskowych');
  }
  const subs = getAllSubscriptions();
  const payload = JSON.stringify({
    title: 'Test powiadomień',
    body: 'Jeśli to widzisz, powiadomienia działają poprawnie.',
    url: APP_URL,
  });

  const wyniki = [];
  for (const sub of subs) {
    let dostawca = 'nieznany';
    try {
      const host = new URL(sub.endpoint).hostname;
      if (host.includes('fcm.googleapis') || host.includes('android')) dostawca = 'Android / Chrome';
      else if (host.includes('push.apple')) dostawca = 'Apple (iPhone)';
      else if (host.includes('mozilla')) dostawca = 'Firefox';
      else dostawca = host;
    } catch { /* zostawiamy "nieznany" */ }

    const wpis = {
      dostawca,
      id: sub.endpoint.slice(-8),
      kategorie: sub.categories || '(wszystkie)',
    };
    try {
      await webpush.sendNotification(JSON.parse(sub.subscription_json), payload);
      wpis.ok = true;
    } catch (err) {
      wpis.ok = false;
      wpis.blad = err.statusCode ? `HTTP ${err.statusCode}` : err.message;
      // 404/410 = subskrypcja wygasla po stronie dostawcy (np. ktos
      // odinstalowal appke). Usuwamy ja, zeby nie zasmiecala statystyk.
      if (err.statusCode === 404 || err.statusCode === 410) {
        deleteSubscription(sub.endpoint);
        wpis.blad += ' - subskrypcja wygasla, usunieto';
      }
    }
    wyniki.push(wpis);
  }

  const udane = wyniki.filter((w) => w.ok).length;
  console.log(`[push] test: dostarczono do ${udane}/${wyniki.length} urzadzen`);
  return { wyslano: udane, wszystkich: wyniki.length, szczegoly: wyniki };
}

// Sprawdza konfiguracje powiadomien przy starcie serwera.
//
// Powod: dwa z trzech bledow tej awarii byly zwyklymi literowkami w
// konfiguracji - adres appki wskazywal na stary, nieuzywany host, a
// kontakt VAPID na niewypelniony wzorzec "twoja-domena.pl". Zaden z nich
// niczego nie wywalil, wiec przelezaly miesiace. Teraz takie rzeczy
// krzycza w logach zaraz po wdrozeniu, zamiast czekac na zgloszenie
// od uzytkownika.
function checkPushConfig() {
  const problemy = [];

  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) {
    problemy.push('brak kluczy VAPID - powiadomienia NIE BEDA wysylane');
  }

  // Adres, ktory otwiera sie po klknieciu, musi byc tym samym, pod ktorym
  // appka jest zainstalowana - inaczej klikniecie otwiera przegladarke.
  if (/onrender\.com/.test(APP_URL)) {
    problemy.push(`APP_URL wskazuje na host Render (${APP_URL}) zamiast na domene appki - klikniecie w powiadomienie otworzy przegladarke, a nie appke`);
  }
  if (!/^https:\/\//.test(APP_URL)) {
    problemy.push(`APP_URL nie jest adresem https (${APP_URL})`);
  }
  if (/twoja-domena|przyklad|example|TODO|zmien/i.test(APP_URL)) {
    problemy.push(`APP_URL wyglada na niewypelniony wzorzec: ${APP_URL}`);
  }
  if (/twoja-domena|przyklad|example|TODO|zmien/i.test(VAPID_CONTACT)) {
    problemy.push(`kontakt VAPID wyglada na niewypelniony wzorzec: ${VAPID_CONTACT}`);
  }

  if (problemy.length) {
    console.error('[push] UWAGA - konfiguracja powiadomien wymaga poprawy:');
    for (const p of problemy) console.error(`[push]   - ${p}`);
  } else {
    console.log(`[push] konfiguracja OK (appka: ${APP_URL}, kontakt: ${VAPID_CONTACT})`);
  }
  return problemy;
}

module.exports = { notifySubscribers, sendTestNotification, checkPushConfig };
