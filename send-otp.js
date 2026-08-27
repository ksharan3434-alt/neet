// /api/send-otp — generates a 6-digit OTP, stores it in Vercel KV,
// and asks OneSignal to push it to the device linked to this phone number.

import { kv } from '@vercel/kv';

const OTP_TTL_SECONDS = 5 * 60;        // OTP valid for 5 minutes
const RESEND_COOLDOWN_SECONDS = 45;    // must wait 45s between sends

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

  const otpKey = `otp:${phone}`;
  const cooldownKey = `otp-cooldown:${phone}`;

  const onCooldown = await kv.get(cooldownKey);
  if (onCooldown) {
    return res.status(429).json({ error: 'Thoda ruko, kuch second baad dobara try karo.' });
  }

  const otp = generateOtp();
  await kv.set(otpKey, JSON.stringify({ otp, attempts: 0 }), { ex: OTP_TTL_SECONDS });
  await kv.set(cooldownKey, '1', { ex: RESEND_COOLDOWN_SECONDS });

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
      await kv.del(otpKey);
      await kv.del(cooldownKey);
      return res.status(412).json({
        error: 'Push notification deliver nahi hui. Notification permission allow karo, phir dobara try karo.',
      });
    }
  } catch (e) {
    return res.status(500).json({ error: 'OneSignal ko call karne mein dikkat aayi.' });
  }

  return res.status(200).json({ success: true });
}
