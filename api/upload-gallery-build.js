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

  const session = requireStaffAuth(req, res);
  if (!session) return;

  try {
    const {
      imageData,
      extraImages = [],
      storeId,
      vehicleYear,
      vehicleMake,
      vehicleModel,
      vehicleTrim,
      wheelLabel,
      tireSize,
      liftKitBrand,
      liftHeight,
      suspensionSetup,
      suspensionSetupNotes,
      noRub,
      noTrim,
      minorRub,
      spacersRequired,
      fitmentNotes,
      caption,
      addedBy,
      lat,
      lng,
    } = req.body || {};

    if (!imageData) return res.status(400).json({ error: 'Hero photo is required.' });

    const geo = assertOnPremises(lat, lng, { skip: isSuperAdminSession(session) });
    if (!geo.ok) return res.status(403).json({ error: geo.error });

    await supabase.storage.createBucket('gallery-builds', { public: true }).catch(() => {});

    const buildId = `build-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const uploadedUrls = [];

    const allImages = [imageData, ...extraImages].filter(Boolean).slice(0, 4);
    for (let i = 0; i < allImages.length; i++) {
      const buffer = base64ToBuffer(allImages[i]);
      const filePath = `${buildId}/${i === 0 ? 'hero' : `detail-${i}`}.jpg`;
      const { error: uploadErr } = await supabase.storage
        .from('gallery-builds')
        .upload(filePath, buffer, { contentType: 'image/jpeg', upsert: true });
      if (uploadErr) throw new Error(`Gallery image upload failed: ${uploadErr.message}`);
      const { data: urlData } = supabase.storage.from('gallery-builds').getPublicUrl(filePath);
      uploadedUrls.push(urlData.publicUrl);
    }

    const entry = {
      id: buildId,
      store_id: storeId || geo.storeId,
      image_url: uploadedUrls[0],
      image_urls: uploadedUrls,
      vehicle_year: vehicleYear || '',
      vehicle_make: vehicleMake || '',
      vehicle_model: vehicleModel || '',
      vehicle_trim: vehicleTrim || '',
      wheel_label: wheelLabel || '',
      tire_size: tireSize || '',
      lift_kit_brand: liftKitBrand || '',
      lift_height: liftHeight || '',
      suspension_setup: suspensionSetup || '',
      suspension_setup_notes: suspensionSetupNotes || '',
      no_rub: noRub ?? null,
      no_trim: noTrim ?? null,
      minor_rub: minorRub ?? null,
      spacers_required: spacersRequired ?? null,
      fitment_notes: fitmentNotes || '',
      caption: caption || '',
      added_by: addedBy || 'Shop team',
      status: 'published',
    };

    const { data, error } = await supabase.from('gallery_builds').insert(entry).select().single();
    if (error) throw new Error(error.message);

    return res.status(200).json({ success: true, entry: data });
  } catch (err) {
    console.error('[upload-gallery-build]', err);
    return res.status(500).json({ error: err.message || 'Gallery publish failed' });
  }
}
