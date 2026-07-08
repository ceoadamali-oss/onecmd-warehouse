/**
 * Dev helper: undo the most recent receive intake for a location (sets stock back to zero for that SKU at that location).
 *
 * Usage (PowerShell):
 *   $env:VITE_SUPABASE_URL="your-url"
 *   $env:VITE_SUPABASE_ANON_KEY="your-key"
 *   node scripts/reset-last-intake.mjs moncton
 */
import { createClient } from '@supabase/supabase-js';

const location = process.argv[2] || 'moncton';
const url = process.env.VITE_SUPABASE_URL;
const key = process.env.VITE_SUPABASE_ANON_KEY;

if (!url || !key) {
  console.error('Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY before running.');
  process.exit(1);
}

const supabase = createClient(url, key);

const { data: txs, error: txErr } = await supabase
  .from('inventory_transactions')
  .select('*')
  .eq('transaction_type', 'receive')
  .eq('to_location', location)
  .order('created_at', { ascending: false })
  .limit(1);

if (txErr) {
  console.error('Failed to load transactions:', txErr.message);
  process.exit(1);
}

const tx = txs?.[0];
if (!tx) {
  console.log(`No receive transactions found for location "${location}".`);
  process.exit(0);
}

console.log(`Undoing intake: ${tx.quantity}x ${tx.sku} at ${location}`);

const { data: tire, error: tireErr } = await supabase
  .from('tires_catalog')
  .select('sku, stock, location_counts')
  .eq('sku', tx.sku)
  .maybeSingle();

if (tireErr) {
  console.error('Failed to load catalog row:', tireErr.message);
  process.exit(1);
}

if (tire) {
  const counts = { ...(tire.location_counts || {}) };
  counts[location] = 0;
  const newTotal = Object.values(counts).reduce((sum, n) => sum + (parseInt(String(n), 10) || 0), 0);

  const { error: updateErr } = await supabase
    .from('tires_catalog')
    .update({ location_counts: counts, stock: newTotal })
    .eq('sku', tx.sku);

  if (updateErr) {
    console.error('Failed to reset stock:', updateErr.message);
    process.exit(1);
  }

  console.log(`Stock reset: ${tx.sku} → ${newTotal} total (${location} = 0)`);
}

const { error: deleteErr } = await supabase.from('inventory_transactions').delete().eq('id', tx.id);
if (deleteErr) {
  console.warn('Stock was reset but could not delete transaction row:', deleteErr.message);
} else {
  console.log('Removed intake transaction record.');
}

console.log('Done.');
