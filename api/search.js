import { createClient } from '@supabase/supabase-js';
import { requireStaffAuth } from './_auth.js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = (supabaseUrl && supabaseServiceKey) ? createClient(supabaseUrl, supabaseServiceKey) : null;

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database configuration missing' });
  }

  if (!await requireStaffAuth(req, res)) return;

  const { query } = req.query || {};
  if (!query || !query.trim()) {
    return res.status(200).json([]);
  }

  try {
    const cleanQuery = query.trim();
    let orFilter = `master_sku.ilike.%${cleanQuery}%,brand.ilike.%${cleanQuery}%,model.ilike.%${cleanQuery}%,size.ilike.%${cleanQuery}%`;
    
    // Add size wildcard normalization (e.g. 2055517 matches 205/55R17)
    const sizeParts = cleanQuery.match(/\d+/g);
    if (sizeParts && sizeParts.length >= 2) {
      const sizeWildcard = sizeParts.join('%');
      orFilter += `,size.ilike.%${sizeWildcard}%`;
    }

    const { data, error } = await supabase
      .from('product_master')
      .select('*, product_location_inventory(*)')
      .or(orFilter)
      .limit(40);

    if (error) throw error;
    return res.status(200).json(data || []);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
