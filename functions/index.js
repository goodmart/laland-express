const {onDocumentUpdated} = require('firebase-functions/v2/firestore');
const {onSchedule} = require('firebase-functions/v2/scheduler');
const {initializeApp} = require('firebase-admin/app');
const {getFirestore} = require('firebase-admin/firestore');
const {getMessaging} = require('firebase-admin/messaging');

initializeApp();
const db = getFirestore();

// Firebase Console > Firestore Database > Data-র "Location" যা, এখানেও তাই দিন
// (যেমন asia-south1, asia-southeast1, us-central1, nam5 হলে us-central1)
const REGION = 'asia-south1';
const OFFER_SECS = 60;

// ১) অ্যাডমিন অর্ডার অ্যাসাইন করলে (offerState = Offered) রাইডারের ফোনে পুশ পাঠাবে
exports.sendOfferPush = onDocumentUpdated({document: 'orders/{orderId}', region: REGION}, async (event) => {
  const b = event.data.before.data() || {};
  const a = event.data.after.data() || {};
  if (a.offerState !== 'Offered' || !a.riderId) return;
  const isNew = b.offerState !== 'Offered' || b.offeredAt !== a.offeredAt || b.riderId !== a.riderId;
  if (!isNew) return;

  const rRef = db.collection('riders').doc(a.riderId);
  const r = (await rRef.get()).data();
  if (!r || r.status === 'Inactive' || !r.fcmToken) return;

  const no = String(a.orderId || event.params.orderId);
  try {
    await getMessaging().send({
      token: r.fcmToken,
      notification: {
        title: '📞 নতুন ডেলিভারি অফার',
        body: `${no} · ৳${a.totalAmount || 0}\n${a.address || ''}`,
      },
      data: {type: 'offer', orderId: event.params.orderId},
      android: {
        priority: 'high',
        ttl: OFFER_SECS * 1000, // ৬০ সেকেন্ড পরে পুরনো অফার আর ডেলিভার হবে না
        notification: {channelId: 'offers', sound: 'offer', defaultVibrateTimings: true},
      },
    });
  } catch (e) {
    console.error('FCM error', e.code, e.message);
    if (e.code === 'messaging/registration-token-not-registered' || e.code === 'messaging/invalid-registration-token') {
      await rRef.update({fcmToken: ''});
    }
  }
});

// ২) অ্যাপ বন্ধ থাকায় রাইডার সাড়া না দিলে, সময় শেষে অফার আবার Processing-এ ফেরত নেবে
exports.expireOffers = onSchedule({schedule: 'every 1 minutes', region: REGION, timeZone: 'Asia/Dhaka'}, async () => {
  const snap = await db.collection('orders').where('offerState', '==', 'Offered').get();
  const now = Date.now();
  for (const d of snap.docs) {
    const t = new Date(d.data().offeredAt).getTime();
    if (isNaN(t) || now - t < (OFFER_SECS + 15) * 1000) continue;
    const at = d.data().offeredAt;
    await db.runTransaction(async (tx) => {
      const s = await tx.get(d.ref);
      const x = s.data();
      if (!x || x.offerState !== 'Offered' || x.offeredAt !== at) return;
      tx.update(d.ref, {
        status: 'Processing', riderPhone: '', riderId: '', riderName: '',
        assignedRiderId: '', assignedRiderName: '', offerState: '', offeredAt: '',
      });
    });
  }
});
