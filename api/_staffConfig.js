import { createClient } from '@supabase/supabase-js';

const CONFIG_SKU = 'CONFIG-EMPLOYEES';

/** Normalize technician PIN to 4-digit string (handles number JSON, whitespace, leading zeros). */
export function normalizeStaffPin(pin) {
  const digits = String(pin ?? '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.padStart(4, '0').slice(-4);
}

function getSupabaseEnv() {
  const url =
    process.env.VITE_SUPABASE_URL ||
    process.env.SUPABASE_URL ||
    '';
  const key =
    process.env.VITE_SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    '';
  return { url, key };
}

function getSupabase() {
  const { url, key } = getSupabaseEnv();
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

/** Merge a patch into one technician record and persist (service role). */
export async function patchStaffTechnician(technicianId, patch) {
  const config = await loadStaffConfig();
  const technicians = [...(config.technicians || [])];
  const index = technicians.findIndex((t) => t?.id === technicianId);
  if (index === -1) throw new Error('Technician not found.');

  technicians[index] = { ...technicians[index], ...patch };
  await saveStaffConfig({ ...config, technicians });
  return technicians[index];
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
    .map((t) => {
      const normalized = normalizeStaffPin(t?.pin);
      if (!normalized) return null;
      return {
        pin: normalized,
        id: t.id,
        name: t.name,
        technicianId: t.id,
        allowOffPremises: Boolean(t.allowOffPremises),
      };
    })
    .filter(Boolean);

  const byPin = new Map();
  for (const entry of envPins) {
    const normalized = normalizeStaffPin(entry?.pin);
    if (normalized) byPin.set(normalized, { ...entry, pin: normalized });
  }
  for (const entry of dbPins) {
    byPin.set(entry.pin, entry);
  }
  return Array.from(byPin.values());
}
