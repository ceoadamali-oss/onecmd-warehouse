import { createClient } from '@supabase/supabase-js';
import { requireStaffAuth } from './_auth.js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = (supabaseUrl && supabaseServiceKey) ? createClient(supabaseUrl, supabaseServiceKey) : null;

// Authoritative Inventory Write Path (H3-BLOCK / Point 4)
async function serverUpdateStockLevel(supabaseClient, sku, type, locationId, diff, productId) {
  const activeLocalLocations = ['moncton', 'oromocto', 'saint-john', 'fredericton', 'otown'];
  if (!locationId || !activeLocalLocations.includes(locationId)) {
    console.log(`ℹ️ [API] Skipping stock update for non-local location: ${locationId}`);
    return null;
  }

  // Resolve product ID if not provided
  if (!productId) {
    const { data: master } = await supabaseClient
      .from('product_master')
      .select('id')
      .eq('master_sku', sku)
      .maybeSingle();
    if (master) productId = master.id;
  }

  if (!productId) {
    throw new Error(`Master product for SKU ${sku} not found.`);
  }

  // 1. Fetch current status & quantity from product_location_inventory
  const { data: pliRow, error: pliErr } = await supabaseClient
    .from('product_location_inventory')
    .select('quantity, inventory_status')
    .eq('product_id', productId)
    .eq('location_id', locationId)
    .maybeSingle();

  if (pliErr) throw pliErr;

  const currentQty = pliRow ? pliRow.quantity : null;
  const currentStatus = pliRow ? pliRow.inventory_status : 'pending';

  let newQty;
  let newStatus = currentStatus;

  // Initialize stock for pending branches upon transaction
  if (currentStatus === 'pending' || currentStatus === 'not-counted') {
    newQty = Math.max(0, diff);
    newStatus = 'complete';
  } else {
    newQty = Math.max(0, (currentQty || 0) + diff);
    newStatus = 'complete';
  }

  // 2. Upsert authoritative product_location_inventory
  const { error: upsertErr } = await supabaseClient
    .from('product_location_inventory')
    .upsert({
      product_id: productId,
      location_id: locationId,
      quantity: newQty,
      inventory_status: newStatus,
      last_counted_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    }, {
      onConflict: 'product_id,location_id'
    });

  if (upsertErr) {
    throw new Error(`Failed to update authoritative PLI: ${upsertErr.message}`);
  }

  // 3. Recalculate Master Total Stock (database trigger will sync legacy mirror automatically)
  await supabaseClient.rpc('recalculate_master_stock', { p_product_id: productId });

  return { newTotal: newQty };
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
    return res.status(500).json({ error: 'Database configuration error.' });
  }

  const session = await requireStaffAuth(req, res);
  if (!session) return;

  const body = req.body || {};
  const action = body.action || 'verify_legacy';

  // --- ACTION: RECEIVE BATCH RECEIPT ---
  if (action === 'receive_receipt') {
    if (session.role !== 'SUPER_ADMIN' && session.role !== 'MANAGER') {
      return res.status(403).json({ error: 'Insufficient permissions. Manager role required.' });
    }
    const { receiptIdempotencyKey, transferBatchId, destinationLocation, receivedBy, notes, items } = body;
    if (!receiptIdempotencyKey || !transferBatchId || !destinationLocation || !receivedBy || !items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Missing required parameters for receive_receipt action.' });
    }

    try {
      const { data, error } = await supabase.rpc('receive_transfer_receipt', {
        p_receipt_idempotency_key: receiptIdempotencyKey,
        p_transfer_batch_id: transferBatchId,
        p_destination_location: destinationLocation,
        p_received_by: receivedBy,
        p_notes: notes || '',
        p_items: items
      });

      if (error) throw error;
      return res.status(200).json(data);
    } catch (error) {
      console.error('❌ [API Serverless] Receive transfer receipt failed:', error.message);
      return res.status(500).json({ error: error.message });
    }
  }

  // --- ACTION: CANCEL BATCH ---
  if (action === 'cancel_batch') {
    if (session.role !== 'SUPER_ADMIN' && session.role !== 'MANAGER') {
      return res.status(403).json({ error: 'Insufficient permissions. Manager role required.' });
    }
    const { transferBatchId, cancelledBy, reason } = body;
    if (!transferBatchId || !cancelledBy || !reason) {
      return res.status(400).json({ error: 'Missing required parameters for cancel_batch action.' });
    }

    try {
      const { data, error } = await supabase.rpc('cancel_transfer_batch', {
        p_transfer_batch_id: transferBatchId,
        p_cancelled_by: cancelledBy,
        p_reason: reason
      });

      if (error) throw error;
      return res.status(200).json(data);
    } catch (error) {
      console.error('❌ [API Serverless] Cancel transfer batch failed:', error.message);
      return res.status(500).json({ error: error.message });
    }
  }

  // --- ACTION: DISPUTE TRANSFER ---
  if (action === 'dispute_transfer') {
    const { transactionId, receivedQuantity, notes, verifiedBy } = body;
    if (!transactionId || typeof receivedQuantity !== 'number' || receivedQuantity < 0 || !verifiedBy) {
      return res.status(400).json({ error: 'Missing or invalid parameters for dispute_transfer action.' });
    }

    try {
      console.log(`⚡ [API Serverless] Disputing transfer transaction ${transactionId}...`);
      
      const { data: tx, error: fetchErr } = await supabase
        .from('inventory_transactions')
        .select('*')
        .eq('id', transactionId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!tx) return res.status(404).json({ error: 'Transaction not found' });

      const newNotes = tx.notes ? `${tx.notes} | Dispute Notes: ${notes || ''}` : (notes || '');

      const { error: updateErr } = await supabase
        .from('inventory_transactions')
        .update({
          status: 'discrepancy',
          received_quantity: receivedQuantity,
          notes: newNotes,
          verified_at: new Date().toISOString(),
          verified_by: verifiedBy
        })
        .eq('id', transactionId);

      if (updateErr) throw updateErr;

      return res.status(200).json({ success: true, status: 'discrepancy' });
    } catch (error) {
      console.error('❌ [API Serverless] Dispute transfer failed:', error.message);
      return res.status(500).json({ error: error.message });
    }
  }

  // --- ACTION: RESOLVE DISCREPANCY ---
  if (action === 'resolve_discrepancy') {
    const { transactionId, resolvedQuantity, notes } = body;
    if (!transactionId || typeof resolvedQuantity !== 'number' || resolvedQuantity < 0) {
      return res.status(400).json({ error: 'Missing or invalid parameters for resolve_discrepancy action.' });
    }

    try {
      console.log(`⚡ [API Serverless] Resolving discrepancy for transaction ${transactionId}...`);

      const { data: tx, error: fetchErr } = await supabase
        .from('inventory_transactions')
        .select('*')
        .eq('id', transactionId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!tx) return res.status(404).json({ error: 'Transaction not found' });

      // Calculate difference between final resolved quantity and original sent quantity
      const diff = resolvedQuantity - tx.quantity;

      // 1. Return the stock difference back to the sender store: add -diff
      let senderUpdate = null;
      if (tx.from_location) {
        senderUpdate = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, -diff, tx.product_id);
      }

      // 2. Add the final resolved quantity to the receiver store
      const receiverLoc = tx.to_location || tx.verified_by;
      let receiverUpdate = null;
      if (receiverLoc) {
        receiverUpdate = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, receiverLoc, resolvedQuantity, tx.product_id);
      }

      const newNotes = tx.notes ? `${tx.notes} | Resolution Notes: ${notes || ''}` : (notes || '');

      // 3. Update transaction to completed
      const { error: updateErr } = await supabase
        .from('inventory_transactions')
        .update({
          quantity: resolvedQuantity,
          received_quantity: resolvedQuantity,
          status: 'completed',
          notes: newNotes,
          verified_at: new Date().toISOString()
        })
        .eq('id', transactionId);

      if (updateErr) throw updateErr;

      return res.status(200).json({ 
        success: true, 
        resolvedQuantity,
        senderUpdate,
        receiverUpdate
      });
    } catch (error) {
      console.error('❌ [API Serverless] Resolve discrepancy failed:', error.message);
      return res.status(500).json({ error: error.message });
    }
  }

  // --- ACTION: LEGACY VERIFY SINGLE ITEM ---
  const { transactionId, receivedQuantity, verifiedBy } = body;
  if (!transactionId || typeof receivedQuantity !== 'number' || receivedQuantity < 0 || !verifiedBy) {
    return res.status(400).json({ error: 'Missing or invalid parameters (transactionId, receivedQuantity, verifiedBy)' });
  }

  try {
    console.log(`⚡ [API Serverless] Verifying transfer transaction ${transactionId}...`);

    // 1. Fetch transaction details
    const { data: tx, error: fetchErr } = await supabase
      .from('inventory_transactions')
      .select('*')
      .eq('id', transactionId)
      .maybeSingle();

    if (fetchErr) throw fetchErr;
    if (!tx) {
      return res.status(404).json({ error: 'Transaction not found' });
    }

    // 2. Update transaction status
    const updatePayload = {
      status: 'completed',
      received_quantity: receivedQuantity,
      verified_at: new Date().toISOString(),
      verified_by: verifiedBy
    };
    if (body.notes) {
      updatePayload.notes = tx.notes ? `${tx.notes} | Recv Notes: ${body.notes}` : body.notes;
    }

    const { error: updateErr } = await supabase
      .from('inventory_transactions')
      .update(updatePayload)
      .eq('id', transactionId);

    if (updateErr) throw updateErr;

    // 3. Add stock to target location (verifiedBy should match to_location)
    const targetLoc = tx.to_location || verifiedBy;
    const stockUpdateResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, targetLoc, receivedQuantity, tx.product_id);

    return res.status(200).json({ 
      success: true, 
      verifiedLocation: targetLoc,
      stockUpdate: stockUpdateResult 
    });
  } catch (error) {
    console.error('❌ [API Serverless] Verify transfer failed:', error.message);
    return res.status(500).json({ error: error.message });
  }
}
