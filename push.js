const webpush = require('web-push');
const { getAllSubscriptions, deleteSubscription } = require('./db');

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
async function notifySubscribers(newItems) {
  if (!newItems || !newItems.length) return;
  if (!ensureConfigured()) {
    console.warn('[push] brak kluczy VAPID w zmiennych srodowiskowych - pomijam wysylke');
    return;
  }

  const subs = getAllSubscriptions();
  if (!subs.length) return;

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

    const payload = JSON.stringify({ title, body, url: first.source_url });

    try {
      await webpush.sendNotification(JSON.parse(sub.subscription_json), payload);
    } catch (err) {
      console.error(`[push] blad wysylki (${sub.endpoint.slice(0, 40)}...):`, err.statusCode || err.message);
      if (err.statusCode === 404 || err.statusCode === 410) {
        // subskrypcja wygasla lub przegladarka ja unieważniła - usuwamy z bazy
        deleteSubscription(sub.endpoint);
      }
    }
  }
}

module.exports = { notifySubscribers };
