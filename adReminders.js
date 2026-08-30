const webpush = require('web-push');
const {
  deactivateExpiredAds, getAdsNeedingReminder, markReminderSent, getAllSubscriptions,
} = require('./db');

let configured = false;
function ensureConfigured() {
  if (configured) return true;
  const { VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY } = process.env;
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails('mailto:kontakt@twoja-domena.pl', VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

async function notifySystemSubscribers(title, body) {
  if (!ensureConfigured()) {
    console.warn('[adReminders] brak kluczy VAPID - pomijam wysylke');
    return;
  }
  const subs = getAllSubscriptions().filter((s) => (s.categories || '').split(',').includes('system'));
  if (!subs.length) {
    console.log('[adReminders] brak subskrybentow "system" - powiadomienie tylko w logach');
    return;
  }
  const payload = JSON.stringify({ title, body, url: 'https://objazdy-zg-frontend.onrender.com/admin.html' });
  for (const sub of subs) {
    try {
      await webpush.sendNotification(JSON.parse(sub.subscription_json), payload);
    } catch (err) {
      console.error('[adReminders] blad wysylki:', err.statusCode || err.message);
    }
  }
}

// Codzienne sprawdzenie reklam: (1) wylacza te, ktorych termin juz minal,
// (2) wysyla przypomnienie push (do subskrybentow "system", czyli do
// administratora appki) dla tych, ktore wygasaja w ciagu 7 dni.
async function runDailyAdCheck() {
  console.log('[adReminders] start codziennego sprawdzenia reklam...');

  const expired = deactivateExpiredAds();
  if (expired.length) {
    const names = expired.map((a) => a.business_name).join(', ');
    console.log(`[adReminders] wylaczono ${expired.length} wygaslych reklam: ${names}`);
    await notifySystemSubscribers(
      '🔴 Wygasły reklamy',
      `Automatycznie wyłączono: ${names}`
    );
  } else {
    console.log('[adReminders] brak wygaslych reklam do wylaczenia');
  }

  const needingReminder = getAdsNeedingReminder();
  for (const ad of needingReminder) {
    console.log(`[adReminders] przypomnienie: "${ad.business_name}" wygasa ${ad.expires_at}`);
    await notifySystemSubscribers(
      '🟡 Reklama wkrótce wygasa',
      `"${ad.business_name}" wygasa ${ad.expires_at} - czas odnowić lub skontaktować się z klientem.`
    );
    markReminderSent(ad.id);
  }
  if (!needingReminder.length) {
    console.log('[adReminders] brak reklam wymagajacych przypomnienia');
  }

  console.log('[adReminders] koniec sprawdzenia.');
}

module.exports = { runDailyAdCheck };
