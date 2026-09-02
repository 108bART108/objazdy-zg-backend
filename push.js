const webpush = require('web-push');
const { getAllSubscriptions, deleteSubscription } = require('./db');

const APP_URL = 'https://objazdy-zg-frontend.onrender.com';

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails('mailto:kontakt@twoja-domena.pl', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
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
  if (!newItems || !newItems.length) return;
  if (!ensureConfigured()) {
    console.warn('[push] brak kluczy VAPID w zmiennych srodowiskowych - pomijam wysylke');
    return;
  }

  const subs = getAllSubscriptions();
  console.log(`[push] ${newItems.length} nowych wpisow, ${subs.length} zarejestrowanych subskrybentow`);
  if (!subs.length) return;

  let sent = 0;
  for (const sub of subs) {
    const prefCategories = sub.categories ? sub.categories.split(',').filter(Boolean) : [];
    const matched = newItems.filter(
      (i) => prefCategories.length === 0 || prefCategories.includes(i.category)
    );
    if (!matched.length) continue;

    const first = matched[0];
    const title = matched.length === 1
      ? `Nowe: ${first.street || first.title}`
      : `Nowe utrudnienia (${matched.length})`;
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
      console.error(`[push] blad wysylki (${sub.endpoint.slice(0, 40)}...):`, err.statusCode || err.message);
      if (err.statusCode === 404 || err.statusCode === 410) {
        deleteSubscription(sub.endpoint);
      }
    }
  }
  console.log(`[push] wyslano ${sent}/${subs.length} powiadomien`);
}

module.exports = { notifySubscribers };
