import { createClient } from '@supabase/supabase-js';
import { requireStaffAuth } from './_auth.js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = (supabaseUrl && supabaseServiceKey) ? createClient(supabaseUrl, supabaseServiceKey) : null;

// Helper to update stock level server-side
async function serverUpdateStockLevel(supabaseClient, sku, type, locationId, diff) {
  const activeLocalLocations = ['moncton', 'oromocto', 'saint-john', 'fredericton', 'otown'];
  if (!locationId || !activeLocalLocations.includes(locationId)) {
    console.log(`ℹ️ [API] Skipping stock update for non-local or empty location: ${locationId}`);
    return null;
  }

  const table = type === 'tire' ? 'tires_catalog' : 'wheels_catalog';

  const { data, error } = await supabaseClient
    .from(table)
    .select('location_counts, stock')
    .eq('sku', sku)
    .maybeSingle();

  if (error) {
    throw new Error(`Could not read stock for ${sku}: ${error.message}`);
  }
  if (!data) {
    throw new Error(`SKU ${sku} not found in catalog — stock was not updated.`);
  }

  const currentCounts = data.location_counts || {};
  const newLocCount = Math.max(0, (currentCounts[locationId] || 0) + diff);
  const newCounts = {
    ...currentCounts,
    [locationId]: newLocCount,
  };
  const newTotal = Object.values(newCounts).reduce((a, b) => a + (parseInt(String(b), 10) || 0), 0);

  const { error: updateError } = await supabaseClient
    .from(table)
    .update({
      location_counts: newCounts,
      stock: newTotal,
    })
    .eq('sku', sku);

  if (updateError) {
    throw new Error(`Could not update stock for ${sku}: ${updateError.message}`);
  }
  
  return { newCounts, newTotal };
}

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!supabase) {
    console.error('❌ Supabase credentials missing in serverless environment variables!');
    return res.status(500).json({ error: 'Database configuration error. Please check your Vercel Environment Variables.' });
  }

  if (!requireStaffAuth(req, res)) return;

  const { transactionId, managerPin } = req.body;
  const expectedPin = process.env.ADMIN_PASSWORD || process.env.SUPER_ADMIN_PASSWORD || '5021';
  if (!managerPin || String(managerPin) !== String(expectedPin)) {
    return res.status(401).json({ error: 'Invalid Manager Override PIN. Access denied.' });
  }

  if (!transactionId) {
    return res.status(400).json({ error: 'Missing transactionId parameter' });
  }

  try {
    console.log(`⚡ [API Serverless] Undo/Delete transaction ${transactionId}...`);

    // 1. Fetch the transaction details first
    const { data: tx, error: fetchErr } = await supabase
      .from('inventory_transactions')
      .select('*')
      .eq('id', transactionId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // 2. Revert the stock updates based on transaction details
    let stockRevertResult = null;
    if (tx.transaction_type === 'receive' && tx.status === 'completed') {
      // Revert receive: subtract quantity from to_location
      stockRevertResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, -tx.quantity);
    } else if (tx.transaction_type === 'transfer' && tx.status === 'completed') {
      // Revert completed transfer: add back to from_location, subtract from to_location
      const addSrc = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, tx.quantity);
      const subDest = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, -tx.quantity);
      stockRevertResult = { addSrc, subDest };
    } else if (tx.transaction_type === 'transfer' && tx.status === 'pending') {
      // Revert pending transfer: add back to from_location
      stockRevertResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, tx.quantity);
    }

    // 3. Delete the transaction
    const { error: deleteErr } = await supabase
      .from('inventory_transactions')
      .delete()
      .eq('id', transactionId);

    if (deleteErr) throw deleteErr;

    return res.status(200).json({ 
      success: true, 
      revertedTransaction: tx,
      stockRevert: stockRevertResult 
    });
  } catch (error) {
    console.error('❌ [API Serverless] Undo transaction failed:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
