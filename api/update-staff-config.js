import { requireStaffAuth, isSuperAdminSession } from './_auth.js';
import { saveStaffConfig } from './_staffConfig.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const session = requireStaffAuth(req, res);
  if (!session) return;
  if (!isSuperAdminSession(session)) {
    return res.status(403).json({ error: 'Only Super Admin can update staff configuration.' });
  }

  const { config } = req.body || {};
  if (!config || typeof config !== 'object') {
    return res.status(400).json({ error: 'config object is required.' });
  }

  try {
    await saveStaffConfig(config);
    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('[API update-staff-config]', error);
    return res.status(500).json({ error: error.message || 'Failed to save staff configuration.' });
  }
}
