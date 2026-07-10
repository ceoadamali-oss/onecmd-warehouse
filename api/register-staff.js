import { requireStaffAuth, isSuperAdminSession } from './_auth.js';
import { loadStaffConfig, normalizeStaffPin, saveStaffConfig } from './_staffConfig.js';

async function sendOnboardingEmail(email, name, pin) {
  const resendKey = process.env.RESEND_API_KEY;
  const subject = 'Your Atlantic Tire King Warehouse Access PIN';
  const html = `
    <h2>Welcome to Atlantic Tire King, ${name}!</h2>
    <p>Your employee account has been created on the warehouse dashboard.</p>
    <p>To access your account, select your location and enter your 4-digit PIN:</p>
    <h1 style="color: #6d28d9; letter-spacing: 5px;">${pin}</h1>
    <p>Please keep this PIN secure. Use it to clock in and out from this app.</p>
  `;

  if (!resendKey) {
    console.warn(`[API register-staff] RESEND_API_KEY missing. Simulated email to: ${email}`);
    return { success: true, simulated: true };
  }

  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${resendKey}`,
    },
    body: JSON.stringify({
      from: 'Atlantic Tire King <onboarding@resend.dev>',
      to: email,
      subject,
      html,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Email delivery failed: ${response.status} ${errText}`);
  }

  const result = await response.json();
  return { success: true, messageId: result.id };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = requireStaffAuth(req, res);
  if (!session) return;
  if (!isSuperAdminSession(session)) {
    return res.status(403).json({ error: 'Only Super Admin can register staff.' });
  }

  const { name, email, specialty, locationId, hourlyRate, preferredDay } = req.body || {};
  if (!name?.trim() || !email?.trim()) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  try {
    const config = await loadStaffConfig();
    const generatedPin = normalizeStaffPin(Math.floor(1000 + Math.random() * 9000).toString());
    const newTech = {
      id: 'tech-' + Math.random().toString(36).substring(2),
      name: name.trim(),
      email: email.trim().toLowerCase(),
      pin: generatedPin,
      specialty: specialty?.trim() || 'General Technician',
      locationId: locationId || 'loc-1',
      hourlyRate: parseFloat(hourlyRate) || 20.0,
      preferredDay: preferredDay || 'None',
      canEditInventory: false,
      canPrintLabels: false,
      canShipOrders: true,
      allowOffPremises: false,
    };

    const updated = {
      ...config,
      technicians: [...(config.technicians || []), newTech],
    };

    await saveStaffConfig(updated);

    const mailResult = await sendOnboardingEmail(newTech.email, newTech.name, generatedPin);

    return res.status(200).json({
      success: true,
      technician: { ...newTech, pin: undefined },
      pin: generatedPin,
      emailSent: mailResult.success,
      emailSimulated: Boolean(mailResult.simulated),
    });
  } catch (error) {
    console.error('[API register-staff]', error);
    return res.status(500).json({ error: error.message || 'Registration failed.' });
  }
}
