import { requireStaffAuth, isSuperAdminSession } from './_auth.js';
import { loadStaffConfig, normalizeStaffPin, patchStaffTechnician, saveStaffConfig } from './_staffConfig.js';

const STAFF_PATCH_FIELDS = new Set([
  'hourlyRate',
  'pin',
  'specialty',
  'locationId',
  'preferredDay',
  'allowOffPremises',
  'canEditInventory',
  'canPrintLabels',
  'canShipOrders',
]);

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
    return res.status(403).json({ error: 'Only Super Admin can manage staff.' });
  }

  const body = req.body || {};

  if (body.action === 'saveConfig') {
    const { config } = body;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'config object is required.' });
    }
    try {
      await saveStaffConfig(config);
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('[API register-staff saveConfig]', error);
      return res.status(500).json({ error: error.message || 'Failed to save staff configuration.' });
    }
  }

  if (body.action === 'updateStaff') {
    const { technicianId, ...rawPatch } = body;
    if (!technicianId?.trim()) {
      return res.status(400).json({ error: 'technicianId is required.' });
    }

    const patch = {};
    for (const [key, value] of Object.entries(rawPatch)) {
      if (STAFF_PATCH_FIELDS.has(key)) patch[key] = value;
    }
    if (!Object.keys(patch).length) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }

    if ('pin' in patch) {
      const pin = normalizeStaffPin(patch.pin);
      if (pin.length !== 4) {
        return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
      }
      patch.pin = pin;
    }

    if ('hourlyRate' in patch) {
      const rate = parseFloat(patch.hourlyRate);
      if (Number.isNaN(rate) || rate <= 0) {
        return res.status(400).json({ error: 'Hourly rate must be a positive number.' });
      }
      patch.hourlyRate = rate;
    }

    if ('allowOffPremises' in patch) patch.allowOffPremises = Boolean(patch.allowOffPremises);
    if ('canEditInventory' in patch) patch.canEditInventory = Boolean(patch.canEditInventory);
    if ('canPrintLabels' in patch) patch.canPrintLabels = Boolean(patch.canPrintLabels);
    if ('canShipOrders' in patch) patch.canShipOrders = Boolean(patch.canShipOrders);

    try {
      const technician = await patchStaffTechnician(technicianId.trim(), patch);
      return res.status(200).json({ success: true, technician });
    } catch (error) {
      console.error('[API register-staff updateStaff]', error);
      return res.status(500).json({ error: error.message || 'Update failed.' });
    }
  }

  const { name, email, specialty, locationId, hourlyRate, preferredDay } = body;
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
