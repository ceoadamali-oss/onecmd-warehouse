/**
 * Verify staff PIN load + match flow (never prints PIN values).
 * Run: node scripts/verify-staff-pin-flow.mjs
 */
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadAllTechnicianPins, normalizeStaffPin } from '../api/_staffConfig.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

function loadEnvFile() {
  const envPath = resolve(__dirname, '../.env');
  try {
    for (const line of readFileSync(envPath, 'utf8').split('\n')) {
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf('=');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      const val = line.slice(i + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {
    /* optional local .env */
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

loadEnvFile();

// Unit: normalization edge cases (no real staff PINs)
assert(normalizeStaffPin(' 1234 ') === '1234', 'trim whitespace');
assert(normalizeStaffPin(5678) === '5678', 'number input');
assert(normalizeStaffPin('12') === '0012', 'pad short pin');
assert(normalizeStaffPin('') === '', 'empty pin');

const pins = await loadAllTechnicianPins();
assert(pins.length > 0, 'expected at least one technician PIN source');

const andy = pins.find((p) => /andy/i.test(p.name || ''));
assert(andy, 'Andy should be present in merged PIN list when Supabase is configured');
assert(normalizeStaffPin(andy.pin).length === 4, 'Andy PIN must normalize to 4 digits');

const matched = pins.find((e) => normalizeStaffPin(e.pin) === normalizeStaffPin(andy.pin));
assert(matched?.name === andy.name, 'normalized PIN lookup must resolve Andy');

console.log('OK verify-staff-pin-flow');
console.log('TECHNICIAN_COUNT', pins.length);
console.log('ANDY_FOUND', Boolean(andy));
console.log('SUPABASE_CONFIGURED', Boolean(process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY));
