import { createClient } from '@supabase/supabase-js';

const CONFIG_SKU = 'CONFIG-EMPLOYEES';

function getSupabase() {
  const url = process.env.VITE_SUPABASE_URL || '';
  const key = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '';
  if (!url || !key) return null;
  return createClient(url, key);
}

export async function loadStaffConfig() {
  const supabase = getSupabase();
  if (!supabase) return { technicians: [], timecards: [], schedules: [] };

  const { data, error } = await supabase
    .from('tires_catalog')
    .select('location_counts')
    .eq('sku', CONFIG_SKU)
    .maybeSingle();

  if (error) throw new Error(`Failed to load staff config: ${error.message}`);
  return data?.location_counts || { technicians: [], timecards: [], schedules: [] };
}

export async function saveStaffConfig(config) {
  const supabase = getSupabase();
  if (!supabase) throw new Error('Server database configuration missing.');

  const { error } = await supabase
    .from('tires_catalog')
    .update({ location_counts: config })
    .eq('sku', CONFIG_SKU);

  if (error) throw new Error(`Failed to save staff config: ${error.message}`);
}

export function loadEnvTechnicianPins() {
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
    /* ignore malformed env */
  }
  return [];
}

/** Merge Supabase technicians (primary) with legacy env PIN list. */
export async function loadAllTechnicianPins() {
  const envPins = loadEnvTechnicianPins();
  let config;
  try {
    config = await loadStaffConfig();
  } catch {
    return envPins;
  }

  const dbPins = (config.technicians || [])
    .filter((t) => t?.pin)
    .map((t) => ({
      pin: String(t.pin),
      id: t.id,
      name: t.name,
      technicianId: t.id,
    }));

  const byPin = new Map();
  for (const entry of envPins) {
    if (entry?.pin) byPin.set(String(entry.pin), entry);
  }
  for (const entry of dbPins) {
    byPin.set(String(entry.pin), entry);
  }
  return Array.from(byPin.values());
}
