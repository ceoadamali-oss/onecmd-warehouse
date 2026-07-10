import { signStaffSession } from './_auth.js';
import { verifyAdminPassword } from './_adminPassword.js';

function loadTechnicianPins() {
  const raw = process.env.TECHNICIAN_PINS_JSON;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      return Object.entries(parsed).map(([pin, info]) => ({
        pin: String(pin),
        ...(typeof info === 'object' && info ? info : { name: String(info) }),
      }));
    }
  } catch {
    /* ignore */
  }
  return [];
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

  if (mode === 'technician') {
    const pins = loadTechnicianPins();
    if (pins.length === 0) {
      return res.status(503).json({ error: 'Technician login is not configured.' });
    }
    const pinValue = pin == null ? '' : String(pin).trim();
    if (!pinValue) {
      return res.status(400).json({ error: 'PIN is required.' });
    }

    const matched = pins.find((entry) => String(entry.pin) === pinValue);
    if (!matched) {
      return res.status(401).json({ error: 'Invalid PIN.' });
    }

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
      locationId,
      locationName: locName,
    });
  }

  return res.status(400).json({ error: 'mode must be "admin" or "technician".' });
}