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

// ── VAPID ─────────────────────────────────────────────────────────────
const VAPID_PUBLIC  = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;
webpush.setVapidDetails('mailto:florea@florea.app', VAPID_PUBLIC, VAPID_PRIVATE);

// ── FIREBASE ADMIN ────────────────────────────────────────────────────
const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
const db = admin.firestore();

// ── ROUTES ────────────────────────────────────────────────────────────
app.get('/', (req, res) => res.json({ status: '🌿 Florea server running' }));

// Route secrète de test — envoie une notif immédiate à tous les abonnés
app.post('/test-notif', async (req, res) => {
  const subsSnap = await db.collection('subscriptions').get();
  if (subsSnap.empty) return res.json({ ok: false, msg: 'Aucun abonné' });

  const subs = subsSnap.docs.map(d => ({ id: d.id, sub: d.data().subscription }));
  const payload = JSON.stringify({
    title: 'Florea 🌿 — Test',
    body: '🔔 Ceci est une notification de test !',
    tag: 'florea-test-' + Date.now(),
  });

  let sent = 0, failed = 0;
  for (const { id, sub } of subs) {
    try {
      await webpush.sendNotification(sub, payload);
      sent++;
    } catch (err) {
      failed++;
      if (err.statusCode === 410 || err.statusCode === 404) {
        await db.collection('subscriptions').doc(id).delete();
      }
    }
  }
  res.json({ ok: true, sent, failed, total: subs.length });
});

// Enregistrer un appareil
app.post('/subscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'No subscription' });
  const id = Buffer.from(subscription.endpoint).toString('base64').slice(0, 40);
  await db.collection('subscriptions').doc(id).set({
    subscription,
    createdAt: admin.firestore.FieldValue.serverTimestamp()
  });
  console.log('New subscription registered');
  res.json({ ok: true });
});

// Désinscrire un appareil
app.post('/unsubscribe', async (req, res) => {
  const { subscription } = req.body;
  if (!subscription?.endpoint) return res.status(400).json({ error: 'No subscription' });
  const id = Buffer.from(subscription.endpoint).toString('base64').slice(0, 40);
  await db.collection('subscriptions').doc(id).delete();
  res.json({ ok: true });
});

// ── VÉRIFICATION & ENVOI DES NOTIFS ──────────────────────────────────
async function checkAndNotify() {
  console.log('Checking plants...', new Date().toISOString());
  const now = Date.now();

  const [plantsSnap, subsSnap] = await Promise.all([
    db.collection('plants').get(),
    db.collection('subscriptions').get()
  ]);

  if (subsSnap.empty) { console.log('No subscribers'); return; }
  const subs = subsSnap.docs.map(d => ({ id: d.id, sub: d.data().subscription }));

  for (const plantDoc of plantsSnap.docs) {
    const p = plantDoc.data();
    if (!p.lastWatered) continue;

    const last = p.lastWatered.toDate
      ? p.lastWatered.toDate().getTime()
      : new Date(p.lastWatered).getTime();

    const nextWater = last + p.frequency * 86400000;
    const hoursLeft = (nextWater - now) / 3600000;

    let payload = null;

    // Notif préventive : dans exactement ~1h
    if (hoursLeft >= 0.5 && hoursLeft <= 1.5) {
      payload = JSON.stringify({
        title: 'Florea 🌿',
        body: `${p.emoji} ${p.name} aura besoin d'eau dans 1 heure !`,
        tag: `plant-soon-${plantDoc.id}`,
      });
    }
    // Notif : c'est l'heure !
    else if (hoursLeft >= -1 && hoursLeft < 0.5) {
      payload = JSON.stringify({
        title: 'Florea 🌿 — À arroser !',
        body: `${p.emoji} ${p.name} a besoin d'eau maintenant !`,
        tag: `plant-now-${plantDoc.id}`,
      });
    }
    // Notif urgente : en retard de moins de 6h
    else if (hoursLeft >= -6 && hoursLeft < -1) {
      payload = JSON.stringify({
        title: 'Florea 🌿 — Urgent !',
        body: `${p.emoji} ${p.name} attend d'être arrosé !`,
        tag: `plant-late-${plantDoc.id}`,
      });
    }

    if (!payload) continue;

    // Envoyer à tous les abonnés
    for (const { id, sub } of subs) {
      try {
        await webpush.sendNotification(sub, payload);
        console.log(`Notif sent for ${p.name}`);
      } catch (err) {
        if (err.statusCode === 410 || err.statusCode === 404) {
          // Subscription expirée
          await db.collection('subscriptions').doc(id).delete();
          console.log('Removed expired subscription');
        } else {
          console.error('Push error:', err.message);
        }
      }
    }
  }
}

// Vérifier toutes les heures
setInterval(checkAndNotify, 60 * 60 * 1000);
// Et au démarrage
setTimeout(checkAndNotify, 3000);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🌿 Florea server on port ${PORT}`));
