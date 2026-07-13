import { signStaffSession, requireStaffAuth, isSuperAdminSession } from './_auth.js';
import { verifyAdminPassword } from './_adminPassword.js';
import { loadAllTechnicianPins, normalizeStaffPin, loadStaffConfig, patchStaffTechnician, saveStaffConfig } from './_staffConfig.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const supabaseAdmin = (supabaseUrl && supabaseServiceKey) ? createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
}) : null;

const supabaseAnon = (supabaseUrl && supabaseAnonKey) ? createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false }
}) : null;

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
    console.warn(`[API staff] RESEND_API_KEY missing. Simulated email to: ${email}`);
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

  const body = req.body || {};

  // --- SUB-ROUTE 1: AUTHENTICATION (LOGIN) ---
  // If the request is for authentication, we don't require an active session token.
  if (body.action === 'auth') {
    const { mode, password, pin, locationId, locationName } = body;
    if (!locationId) {
      return res.status(400).json({ error: 'locationId is required.' });
    }

    const locName = locationName || locationId;

    if (mode === 'admin') {
      const check = verifyAdminPassword(password);
      if (!check.configured) {
        return res.status(503).json({ error: 'Admin login is not configured.' });
      }
      if (!check.ok) {
        return res.status(401).json({ error: 'Invalid admin password.' });
      }

      if (!supabaseAdmin || !supabaseAnon) {
        const token = signStaffSession({
          username: 'admin',
          role: 'SUPER_ADMIN',
          locationId,
          locationName: locName,
        });
        return res.status(200).json({
          token,
          role: 'SUPER_ADMIN',
          name: 'Super Admin (Mock)',
          locationId,
          locationName: locName
        });
      }

      const adminEmail = 'admin@atking.com';
      const adminPassword = password;
      let adminUserId;

      try {
        const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
        const existingUser = users.find(u => u.email === adminEmail);

        if (!existingUser) {
          const { data: createData, error: createErr } = await supabaseAdmin.auth.admin.createUser({
            email: adminEmail,
            password: adminPassword,
            email_confirm: true
          });
          if (createErr) throw createErr;
          adminUserId = createData.user.id;
        } else {
          adminUserId = existingUser.id;
          const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(adminUserId, {
            password: adminPassword
          });
          if (updateErr) throw updateErr;
        }

        const { error: profileErr } = await supabaseAdmin.from('staff_profiles').upsert({
          user_id: adminUserId,
          role: 'super_admin',
          username: 'super_admin'
        });
        if (profileErr) throw profileErr;

        const { data: authData, error: authErr } = await supabaseAnon.auth.signInWithPassword({
          email: adminEmail,
          password: adminPassword
        });
        if (authErr) throw authErr;

        return res.status(200).json({
          token: authData.session.access_token,
          role: 'SUPER_ADMIN',
          name: 'Super Admin',
          locationId,
          locationName: locName,
        });

      } catch (err) {
        console.error('[API staff admin auth] Supabase fallback triggered:', err);
        const token = signStaffSession({
          username: 'admin',
          role: 'SUPER_ADMIN',
          locationId,
          locationName: locName,
        });
        return res.status(200).json({
          token,
          role: 'SUPER_ADMIN',
          name: 'Super Admin',
          locationId,
          locationName: locName,
        });
      }
    }

    // PIN Technician Login
    const normalizedPinInput = normalizeStaffPin(pin);
    if (!normalizedPinInput) {
      return res.status(400).json({ error: 'PIN code must be exactly 4 digits.' });
    }

    try {
      const dbTechs = await loadAllTechnicianPins();
      const matched = dbTechs.find(t => normalizeStaffPin(t.pin) === normalizedPinInput);

      if (!matched) {
        return res.status(401).json({ error: 'Invalid PIN code.' });
      }

      if (matched.locationId && matched.locationId !== locationId) {
        return res.status(403).json({ error: `Access Denied: Technician assigned to ${matched.locationId}.` });
      }

      // Provision technician in Supabase Auth dynamically
      const techEmail = `${matched.id}@atking.com`;
      const techPassword = `pin-login-${normalizedPinInput}-secure`;
      let techUserId;

      if (supabaseAdmin && supabaseAnon) {
        try {
          const { data: { users } } = await supabaseAdmin.auth.admin.listUsers();
          const existingUser = users.find(u => u.email === techEmail);

          if (!existingUser) {
            const { data: createData, error: createErr } = await supabaseAdmin.auth.admin.createUser({
              email: techEmail,
              password: techPassword,
              email_confirm: true
            });
            if (createErr) throw createErr;
            techUserId = createData.user.id;
          } else {
            techUserId = existingUser.id;
          }

          const { error: profileErr } = await supabaseAdmin.from('staff_profiles').upsert({
            user_id: techUserId,
            role: 'worker',
            username: matched.id
          });
          if (profileErr) throw profileErr;

          const { data: authData, error: authErr } = await supabaseAnon.auth.signInWithPassword({
            email: techEmail,
            password: techPassword
          });
          if (authErr) throw authErr;

          return res.status(200).json({
            token: authData.session.access_token,
            role: matched.role === 'manager' ? 'MANAGER' : 'WORKER',
            name: matched.name,
            locationId,
            locationName: locName,
            technicianId: matched.id,
          });

        } catch (authErr) {
          console.error('[API staff tech auth] Supabase fallback triggered:', authErr);
        }
      }

      // Fallback
      const token = signStaffSession({
        username: matched.id,
        role: matched.role === 'manager' ? 'MANAGER' : 'WORKER',
        locationId,
        locationName: locName,
        technicianId: matched.id,
      });

      return res.status(200).json({
        token,
        role: matched.role === 'manager' ? 'MANAGER' : 'WORKER',
        name: matched.name,
        locationId,
        locationName: locName,
        technicianId: matched.id,
      });

    } catch (err) {
      console.error('[API staff PIN auth failed]', err);
      return res.status(500).json({ error: err.message || 'Database error during PIN login.' });
    }
  }

  // --- SUB-ROUTE 2: STAFF CONFIG & REGISTRATION (REQUIRES AUTH) ---
  const session = await requireStaffAuth(req, res);
  if (!session) return;
  if (!isSuperAdminSession(session)) {
    return res.status(403).json({ error: 'Only Super Admin can manage staff.' });
  }

  if (body.action === 'saveConfig') {
    const { config } = body;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'config object is required.' });
    }
    try {
      await saveStaffConfig(config);
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('[API staff saveConfig]', error);
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
      if (!pin) return res.status(400).json({ error: 'PIN must be exactly 4 numeric digits.' });
      patch.pin = pin;
    }

    try {
      await patchStaffTechnician(technicianId, patch);
      return res.status(200).json({ success: true });
    } catch (error) {
      console.error('[API staff updateStaff]', error);
      return res.status(500).json({ error: error.message || 'Failed to update technician.' });
    }
  }

  // Register Worker (Intake / Onboarding)
  let { id, name, pin, role, hourlyRate, specialty, locationId, email, preferredDay } = body;

  if (!name?.trim() || !email?.trim()) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  if (!role) role = 'worker';
  if (!pin) {
    pin = Math.floor(1000 + Math.random() * 9000).toString();
  }
  if (!id) {
    const cleanName = name.trim().toLowerCase().replace(/[^a-z0-9]/g, '-');
    id = `tech-${cleanName}`;
  }

  const normalizedPin = normalizeStaffPin(pin);
  if (!normalizedPin) {
    return res.status(400).json({ error: 'PIN must be exactly 4 digits.' });
  }

  try {
    const config = await loadStaffConfig();
    if (config.technicians.some((t) => t.id === id)) {
      return res.status(409).json({ error: 'Technician ID already exists.' });
    }
    if (config.technicians.some((t) => normalizeStaffPin(t.pin) === normalizedPin)) {
      return res.status(409).json({ error: 'PIN code is already assigned to another technician.' });
    }

    const newTech = {
      id,
      name,
      pin: normalizedPin,
      role,
      hourlyRate: Number(hourlyRate) || 0,
      specialty: specialty || '',
      locationId: locationId || '',
      email,
      preferredDay: preferredDay || 'Monday',
      allowOffPremises: false,
      canEditInventory: true,
      canPrintLabels: true,
      canShipOrders: true,
    };

    config.technicians.push(newTech);
    await saveStaffConfig(config);

    const emailStatus = await sendOnboardingEmail(email, name, normalizedPin);

    return res.status(200).json({
      success: true,
      technician: newTech,
      pin: normalizedPin,
      emailSimulated: emailStatus.simulated,
    });
  } catch (error) {
    console.error('[API staff register]', error);
    return res.status(500).json({ error: error.message || 'Registration failed.' });
  }
}
