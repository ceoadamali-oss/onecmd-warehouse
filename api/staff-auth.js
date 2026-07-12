import { signStaffSession } from './_auth.js';
import { verifyAdminPassword } from './_adminPassword.js';
import { loadAllTechnicianPins, normalizeStaffPin } from './_staffConfig.js';
import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || process.env.SUPABASE_URL || '';
const supabaseServiceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || '';
const supabaseAnonKey = process.env.VITE_SUPABASE_ANON_KEY || process.env.SUPABASE_ANON_KEY || '';

const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false }
});

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { mode, password, pin, locationId, locationName } = req.body || {};
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

    // Provision Super Admin in Supabase Auth dynamically
    const adminEmail = 'admin@atking.com';
    const adminPassword = password; // use the admin password
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
        // Update password to match in case it rotated
        const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(adminUserId, {
          password: adminPassword
        });
        if (updateErr) throw updateErr;
      }

      // Upsert profile in staff_profiles
      const { error: profileErr } = await supabaseAdmin.from('staff_profiles').upsert({
        user_id: adminUserId,
        role: 'super_admin',
        username: 'super_admin'
      });
      if (profileErr) throw profileErr;

      // Log in via Supabase Auth to get the genuine JWT token
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
      console.error('[API staff-auth admin] Supabase Auth provisioning failed:', err);
      // Fallback to custom session token if Supabase auth fails (for local testing without DB)
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

  if (mode === 'technician') {
    const pins = await loadAllTechnicianPins();
    if (pins.length === 0) {
      return res.status(503).json({ error: 'Technician login is not configured.' });
    }
    const pinValue = normalizeStaffPin(pin);
    if (!pinValue) {
      return res.status(400).json({ error: 'PIN is required.' });
    }

    const matched = pins.find((entry) => normalizeStaffPin(entry.pin) === pinValue);
    if (!matched) {
      return res.status(401).json({ error: 'Invalid PIN.' });
    }

    // Provision Technician in Supabase Auth dynamically
    const techEmail = matched.email || `tech_${matched.id}@atking.com`;
    const techPassword = `PinPassword_${pinValue}_Secret!`;
    let techUserId;

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
        const { error: updateErr } = await supabaseAdmin.auth.admin.updateUserById(techUserId, {
          password: techPassword
        });
        if (updateErr) throw updateErr;
      }

      // Upsert profile in staff_profiles
      const { error: profileErr } = await supabaseAdmin.from('staff_profiles').upsert({
        user_id: techUserId,
        role: 'warehouse_employee',
        username: matched.id || 'technician'
      });
      if (profileErr) throw profileErr;

      // Upsert location assignment in staff_location_assignments
      const { error: assignErr } = await supabaseAdmin.from('staff_location_assignments').upsert({
        user_id: techUserId,
        location_id: locationId,
        active: true
      });
      if (assignErr) throw assignErr;

      // Log in via Supabase Auth
      const { data: authData, error: authErr } = await supabaseAnon.auth.signInWithPassword({
        email: techEmail,
        password: techPassword
      });
      if (authErr) throw authErr;

      return res.status(200).json({
        token: authData.session.access_token,
        role: 'TECHNICIAN',
        name: matched.name || 'Technician',
        technicianId: matched.id || matched.technicianId,
        allowOffPremises: Boolean(matched.allowOffPremises),
        canEditInventory: Boolean(matched.canEditInventory),
        canPrintLabels: Boolean(matched.canPrintLabels),
        canShipOrders: matched.canShipOrders !== false,
        locationId,
        locationName: locName,
      });

    } catch (err) {
      console.error('[API staff-auth technician] Supabase Auth provisioning failed:', err);
      // Fallback to custom session token if Supabase auth fails
      const token = signStaffSession({
        username: matched.name || matched.id || 'technician',
        role: 'TECHNICIAN',
        locationId,
        locationName: locName,
        technicianId: matched.id || matched.technicianId || undefined,
      });
      return res.status(200).json({
        token,
        role: 'TECHNICIAN',
        name: matched.name || 'Technician',
        technicianId: matched.id || matched.technicianId,
        allowOffPremises: Boolean(matched.allowOffPremises),
        canEditInventory: Boolean(matched.canEditInventory),
        canPrintLabels: Boolean(matched.canPrintLabels),
        canShipOrders: matched.canShipOrders !== false,
        locationId,
        locationName: locName,
      });
    }
  }

  return res.status(400).json({ error: 'mode must be "admin" or "technician".' });
}