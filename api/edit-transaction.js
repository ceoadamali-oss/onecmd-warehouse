import { createClient } from '@supabase/supabase-js';

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
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
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

  const { transactionId, newQuantity, notes } = req.body;
  if (!transactionId || typeof newQuantity !== 'number' || newQuantity <= 0) {
    return res.status(400).json({ error: 'Missing or invalid parameters (transactionId, newQuantity)' });
  }

  try {
    console.log(`⚡ [API Serverless] Editing quantity for transaction ${transactionId} to ${newQuantity}...`);

    // 1. Fetch the transaction details first to calculate difference
    const { data: tx, error: fetchErr } = await supabase
      .from('inventory_transactions')
      .select('*')
      .eq('id', transactionId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    const diff = newQuantity - tx.quantity;

    // 2. Update stock counts based on the difference
    let stockUpdateResult = null;
    if (tx.transaction_type === 'receive' && tx.status === 'completed') {
      stockUpdateResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, diff);
    } else if (tx.transaction_type === 'transfer' && tx.status === 'completed') {
      // Revert difference: subtract from from_location, add to to_location (since diff is newQuantity - oldQuantity)
      const subSrc = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, -diff);
      const addDest = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, diff);
      stockUpdateResult = { subSrc, addDest };
    } else if (tx.transaction_type === 'transfer' && tx.status === 'pending') {
      // Subtract from from_location (diff is subtracted since it represents items leaving)
      stockUpdateResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, -diff);
    }

    // 3. Update the transaction row
    const updatePayload = {
      quantity: newQuantity,
      notes: notes || tx.notes
    };

    const { data: updatedTx, error: updateErr } = await supabase
      .from('inventory_transactions')
      .update(updatePayload)
      .eq('id', transactionId)
      .select()
      .single();

    if (updateErr) throw updateErr;

    return res.status(200).json({ 
      success: true, 
      transaction: updatedTx,
      stockUpdate: stockUpdateResult 
    });
  } catch (error) {
    console.error('❌ [API Serverless] Edit transaction failed:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
