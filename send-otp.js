// /api/send-otp — generates a 6-digit OTP, stores it in Firebase Firestore,
// and asks OneSignal to push it to the device linked to this phone number.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';

const OTP_TTL_MS = 5 * 60 * 1000;       // OTP valid for 5 minutes
const RESEND_COOLDOWN_MS = 45 * 1000;   // must wait 45s between sends

function getDb() {
  if (!getApps().length) {
    // FIREBASE_SERVICE_ACCOUNT env var holds the full JSON key as one string
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

function normalizePhone(raw) {
  const str = String(raw || '').trim();
  if (str.startsWith('+')) return str;
  const digits = str.replace(/\D/g, '');
  if (digits.length === 10) return '+91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return '+' + digits;
  return null;
}

function generateOtp() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const phone = normalizePhone(req.body?.phone);
  if (!phone) {
    return res.status(400).json({ error: 'Valid 10-digit phone number chahiye.' });
  }

  const db = getDb();
  const ref = db.collection('otps').doc(phone);
  const snap = await ref.get();
  const now = Date.now();

  if (snap.exists) {
    const data = snap.data();
    if (data.createdAt && now - data.createdAt < RESEND_COOLDOWN_MS) {
      const wait = Math.ceil((RESEND_COOLDOWN_MS - (now - data.createdAt)) / 1000);
      return res.status(429).json({ error: `Thoda ruko, ${wait}s baad dobara try karo.` });
    }
  }

  const otp = generateOtp();
  await ref.set({ otp, createdAt: now, expiresAt: now + OTP_TTL_MS, attempts: 0 });

  try {
    const resp = await fetch('https://onesignal.com/api/v1/notifications', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Authorization': `Basic ${process.env.ONESIGNAL_REST_API_KEY}`,
      },
      body: JSON.stringify({
        app_id: process.env.ONESIGNAL_APP_ID,
        include_aliases: { external_id: [phone] },
        target_channel: 'push',
        headings: { en: 'Science World — Login OTP' },
        contents: { en: `Your OTP is ${otp}. Valid for 5 minutes. Don't share it with anyone.` },
      }),
    });
    const result = await resp.json();

    if (!(result.recipients > 0)) {
      await ref.delete();
      return res.status(412).json({
        error: 'Push notification deliver nahi hui. Notification permission allow karo, phir dobara try karo.',
      });
    }
  } catch (e) {
    return res.status(500).json({ error: 'OneSignal ko call karne mein dikkat aayi.' });
  }

  return res.status(200).json({ success: true });
}
