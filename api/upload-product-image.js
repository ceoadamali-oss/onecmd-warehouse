import { createClient } from '@supabase/supabase-js';
import { assertOnPremises } from './_geofence.js';
import { isSuperAdminSession, requireStaffAuth } from './_auth.js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '';
const supabase =
  supabaseUrl && supabaseServiceKey ? createClient(supabaseUrl, supabaseServiceKey) : null;

function base64ToBuffer(base64Str) {
  const clean = base64Str.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(clean, 'base64');
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });
  if (!supabase) return res.status(500).json({ error: 'Server database configuration missing.' });

  const session = await requireStaffAuth(req, res);
  if (!session) return;

  try {
    const { sku, productType, imageData, lat, lng, employeeId } = req.body || {};
    if (!sku || !productType || !imageData) {
      return res.status(400).json({ error: 'sku, productType, and imageData are required.' });
    }

    const geo = assertOnPremises(lat, lng, { skip: isSuperAdminSession(session) });
    if (!geo.ok) return res.status(403).json({ error: geo.error });

    const skuKey = String(sku).toUpperCase().trim();
    const table = productType === 'wheel' ? 'wheels_catalog' : 'tires_catalog';
    const buffer = base64ToBuffer(imageData);
    const filePath = `${skuKey}.jpg`;

    await supabase.storage.createBucket('product-images', { public: true }).catch(() => {});

    const { error: uploadErr } = await supabase.storage
      .from('product-images')
      .upload(filePath, buffer, { contentType: 'image/jpeg', upsert: true });

    if (uploadErr) throw new Error(`Image upload failed: ${uploadErr.message}`);

    const { data: urlData } = supabase.storage.from('product-images').getPublicUrl(filePath);
    const publicUrl = urlData.publicUrl;

    const { error: updateErr } = await supabase
      .from(table)
      .update({ image: publicUrl })
      .eq('sku', skuKey);

    if (updateErr) throw new Error(`Catalog update failed: ${updateErr.message}`);

    return res.status(200).json({
      success: true,
      imageUrl: publicUrl,
      storeId: geo.storeId,
      updatedBy: employeeId || 'warehouse',
    });
  } catch (err) {
    console.error('[upload-product-image]', err);
    return res.status(500).json({ error: err.message || 'Upload failed' });
  }
}
