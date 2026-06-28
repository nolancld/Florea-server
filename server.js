const express = require('express');
const webpush = require('web-push');
const admin = require('firebase-admin');

const app = express();
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── CONFIG ────────────────────────────────────────────────────────────
webpush.setVapidDetails(
  'mailto:florea@florea.app',
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── UTILS ─────────────────────────────────────────────────────────────
function subDocId(endpoint) {
  return Buffer.from(endpoint).toString('base64').slice(0, 40);
}

async function sendToSubs(subs, payload) {
  let sent = 0, failed = 0;
  for (const { docId, sub } of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410 || err.statusCode === 404) {
        // Subscription expirée — on la supprime du jardin
        await db.collection('subscriptions').doc(docId).delete().catch(() => {});
        console.log('Removed expired subscription:', docId);
      } else {
        console.error('Push error:', err.message);
      }
    }
  }
  return { sent, failed };
}

// ── ROUTES ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: '🌿 Florea server running' }));

// Enregistrer un appareil pour un jardin
// Structure Firestore : subscriptions/{docId} = { subscription, gardenId, ... }
app.post('/subscribe', async (req, res) => {
  const { subscription, gardenId } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'No subscription' });
  if (!gardenId) return res.status(400).json({ error: 'No gardenId' });

  const docId = subDocId(subscription.endpoint);
  await db.collection('subscriptions').doc(docId).set({
    subscription,
    gardenId,
    updatedAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log(`Subscription registered for garden ${gardenId.slice(0,8)}...`);
  res.json({ ok: true });
});

// Désinscrire un appareil
app.post('/unsubscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'No subscription' });
  const docId = subDocId(subscription.endpoint);
  await db.collection('subscriptions').doc(docId).delete();
  res.json({ ok: true });
});

// Test notif — envoie à tous les abonnés du jardin concerné
app.post('/test-notif', async (req, res) => {
  const { gardenId } = req.body;
  if (!gardenId) return res.status(400).json({ error: 'No gardenId' });

  const subsSnap = await db.collection('subscriptions').get();
  const subs = subsSnap.docs
    .filter(d => d.data().gardenId === gardenId)
    .map(d => ({ docId: d.id, sub: d.data().subscription }));

  if (subs.length === 0) return res.json({ ok: false, msg: 'Aucun abonné pour ce jardin' });

  const payload = JSON.stringify({
    title: 'Florea 🌿 — Test',
    body: '🔔 Ceci est une notification de test !',
    tag: 'florea-test-' + Date.now(),
  });

  const { sent, failed } = await sendToSubs(subs, payload);
  res.json({ ok: true, sent, failed, total: subs.length });
});

// ── CHECK & NOTIFY ────────────────────────────────────────────────────
async function checkAndNotify() {
  console.log('Checking all gardens...', new Date().toISOString());
  const now = Date.now();

  // Récupérer tous les jardins
  const gardensSnap = await db.collection('gardens').get();
  if (gardensSnap.empty) { console.log('No gardens'); return; }

  // Récupérer toutes les subscriptions groupées par gardenId
  const subsSnap = await db.collection('subscriptions').get();
  const subsByGarden = {};
  subsSnap.docs.forEach(d => {
    const { subscription, gardenId } = d.data();
    if (!gardenId) return;
    if (!subsByGarden[gardenId]) subsByGarden[gardenId] = [];
    subsByGarden[gardenId].push({ docId: d.id, sub: subscription });
  });

  // Pour chaque jardin qui a des abonnés, vérifier les plantes
  for (const gardenDoc of gardensSnap.docs) {
    const gardenId = gardenDoc.id;
    const subs = subsByGarden[gardenId];
    if (!subs || subs.length === 0) continue;

    const plantsSnap = await db.collection('gardens').doc(gardenId).collection('plants').get();
    if (plantsSnap.empty) continue;

    for (const plantDoc of plantsSnap.docs) {
      const p = plantDoc.data();
      if (!p.lastWatered) continue;

      const last = p.lastWatered.toDate
        ? p.lastWatered.toDate().getTime()
        : new Date(p.lastWatered).getTime();

      const nextWater = last + p.frequency * 86400000;
      const hoursLeft = (nextWater - now) / 3600000;

      let payload = null;

      if (hoursLeft >= 0.5 && hoursLeft <= 1.5) {
        payload = JSON.stringify({
          title: 'Florea 🌿',
          body: `${p.emoji} ${p.name} aura besoin d'eau dans 1 heure !`,
          tag: `plant-soon-${plantDoc.id}`,
        });
      } else if (hoursLeft >= -1 && hoursLeft < 0.5) {
        payload = JSON.stringify({
          title: 'Florea 🌿 — À arroser !',
          body: `${p.emoji} ${p.name} a besoin d'eau maintenant !`,
          tag: `plant-now-${plantDoc.id}`,
        });
      } else if (hoursLeft >= -6 && hoursLeft < -1) {
        payload = JSON.stringify({
          title: 'Florea 🌿 — Urgent !',
          body: `${p.emoji} ${p.name} attend d'être arrosé !`,
          tag: `plant-late-${plantDoc.id}`,
        });
      }

      if (payload) {
        console.log(`Sending notif for ${p.name} (garden ${gardenId.slice(0,8)}...)`);
        await sendToSubs(subs, payload);
      }
    }
  }
}

setInterval(checkAndNotify, 60 * 60 * 1000);
setTimeout(checkAndNotify, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌿 Florea server on port ${PORT}`));
