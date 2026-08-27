// /api/verify-otp — checks the OTP against Vercel KV and, if correct,
// issues a signed session token the frontend stores in localStorage.

import { kv } from '@vercel/kv';
import crypto from 'crypto';

const MAX_ATTEMPTS = 5;
const SESSION_DAYS = 7;

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

  const otpKey = `otp:${phone}`;
  const raw = await kv.get(otpKey);
  if (!raw) {
    return res.status(404).json({ error: 'OTP nahi mila, pehle "Send OTP" dabao.' });
  }

  const data = typeof raw === 'string' ? JSON.parse(raw) : raw;

  if (data.attempts >= MAX_ATTEMPTS) {
    await kv.del(otpKey);
    return res.status(429).json({ error: 'Bahut galat attempts ho gaye. Naya OTP bhejo.' });
  }

  if (data.otp !== otp) {
    data.attempts += 1;
    await kv.set(otpKey, JSON.stringify(data), { keepTtl: true });
    return res.status(400).json({ error: 'Galat OTP.' });
  }

  await kv.del(otpKey);
  const token = signToken(phone);
  return res.status(200).json({ token, phone });
}
