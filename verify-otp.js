// /api/verify-otp — checks the OTP against Firestore and, if correct,
// issues a signed session token the frontend stores in localStorage.

import { initializeApp, getApps, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import crypto from 'crypto';

const MAX_ATTEMPTS = 5;
const SESSION_DAYS = 7;

function getDb() {
  if (!getApps().length) {
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

function signToken(phone) {
  const payload = Buffer.from(
    JSON.stringify({ phone, exp: Date.now() + SESSION_DAYS * 24 * 3600 * 1000 })
  ).toString('base64url');
  const secret = process.env.SESSION_SECRET || 'change-me-please';
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const phone = normalizePhone(req.body?.phone);
  const otp = String(req.body?.otp || '').trim();
  if (!phone || !otp) {
    return res.status(400).json({ error: 'Phone aur OTP dono chahiye.' });
  }

  const db = getDb();
  const ref = db.collection('otps').doc(phone);
  const snap = await ref.get();

  if (!snap.exists) {
    return res.status(404).json({ error: 'OTP nahi mila, pehle "Send OTP" dabao.' });
  }

  const data = snap.data();
  const now = Date.now();

  if (now > data.expiresAt) {
    await ref.delete();
    return res.status(410).json({ error: 'OTP expire ho gaya, naya bhejo.' });
  }

  if (data.attempts >= MAX_ATTEMPTS) {
    await ref.delete();
    return res.status(429).json({ error: 'Bahut galat attempts ho gaye. Naya OTP bhejo.' });
  }

  if (data.otp !== otp) {
    await ref.update({ attempts: (data.attempts || 0) + 1 });
    return res.status(400).json({ error: 'Galat OTP.' });
  }

  await ref.delete();
  const token = signToken(phone);
  return res.status(200).json({ token, phone });
}
