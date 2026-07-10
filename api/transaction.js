import { createClient } from '@supabase/supabase-js';
import { verifyAdminPassword } from './_adminPassword.js';
import { requireStaffAuth } from './_auth.js';

const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = (supabaseUrl && supabaseServiceKey) ? createClient(supabaseUrl, supabaseServiceKey) : null;

// Base64 helper for image upload
function base64ToBuffer(base64Str) {
  const cleanBase64 = base64Str.replace(/^data:image\/\w+;base64,/, '');
  return Buffer.from(cleanBase64, 'base64');
}

// Helper function to update catalog stock values inside Supabase jsonb
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

  const body = req.body || {};
  
  // Decide which transaction action to execute: 'sync' (default), 'edit', or 'undo'
  const action = body.action || 'sync';

  // --- ACTION 1: SYNC TRANSACTION (Receive / Move) ---
  if (action === 'sync') {
    const tx = body.tx ? body.tx : body;
    const newProduct = body.newProduct || null;

    if (!tx || !tx.sku || !tx.product_type || !tx.transaction_type || !tx.quantity) {
      return res.status(400).json({ error: 'Missing required transaction fields (sku, product_type, transaction_type, quantity)' });
    }

    const skuKey = tx.sku.toUpperCase().trim();
    const isWheel = tx.product_type === 'wheel';
    const table = isWheel ? 'wheels_catalog' : 'tires_catalog';

    try {
      console.log(`⚡ [API Serverless] Syncing transaction for SKU: ${skuKey}...`);
      
      const { data: existingItem, error: checkError } = await supabase
        .from(table)
        .select('sku')
        .eq('sku', skuKey)
        .maybeSingle();

      if (checkError) throw checkError;
      const itemExists = !!existingItem;

      if (!itemExists) {
        console.log(`⚡ [API Serverless] Creating missing catalog item for SKU: ${skuKey}...`);
        let publicImageUrl = '';

        if (newProduct && newProduct.productPhoto) {
          try {
            const buffer = base64ToBuffer(newProduct.productPhoto);
            const filePath = `${skuKey}.jpg`;
            await supabase.storage.createBucket('product-images', { public: true }).catch(() => {});
            const { error: uploadErr } = await supabase.storage
              .from('product-images')
              .upload(filePath, buffer, {
                contentType: 'image/jpeg',
                upsert: true
              });

            if (!uploadErr) {
              const { data: urlData } = supabase.storage
                .from('product-images')
                .getPublicUrl(filePath);
              publicImageUrl = urlData.publicUrl;
            }
          } catch (imgErr) {
            console.error("❌ Image upload process failed:", imgErr);
          }
        }

        let catalogName = '';
        let brandName = 'Unknown Brand';
        let sizeValue = 'N/A';
        let typeValue = 'All-Season';
        let winterApprovedVal = false;

        if (newProduct) {
          brandName = newProduct.brand || brandName;
          sizeValue = newProduct.size || sizeValue;
          typeValue = newProduct.season || typeValue;
          winterApprovedVal = !!newProduct.winterApproved;

          catalogName = `${brandName} ${newProduct.model || ''}`;
          if (isWheel) {
            if (newProduct.finish) catalogName += ` ${newProduct.finish}`;
            catalogName += ` (${sizeValue}`;
            if (newProduct.bolt_pattern) catalogName += ` PCD:${newProduct.bolt_pattern}`;
            if (newProduct.offset) catalogName += ` ET:${newProduct.offset}`;
            if (newProduct.center_bore) catalogName += ` CB:${newProduct.center_bore}`;
            catalogName += ')';
          } else {
            if (newProduct.ply_rating && newProduct.ply_rating !== 'N/A') {
              catalogName += ` (${newProduct.ply_rating})`;
            }
            if (winterApprovedVal) catalogName += ' 3PMSF';
          }
        } else {
          catalogName = `Received Catalog SKU: ${skuKey}`;
        }

        const insertPayload = {
          sku: skuKey,
          brand: brandName,
          size: sizeValue,
          name: catalogName,
          price: isWheel ? 180 : 120,
          stock: 0,
          image: publicImageUrl,
          location_counts: {}
        };

        if (!isWheel) insertPayload.type = typeValue;

        const { error: upsertErr } = await supabase.from(table).upsert(insertPayload);
        if (upsertErr) throw upsertErr;
      }

      const { data: insertedData, error: txError } = await supabase.from('inventory_transactions').insert({
        id: tx.id || undefined,
        sku: skuKey,
        product_type: tx.product_type,
        transaction_type: tx.transaction_type,
        quantity: tx.quantity,
        from_location: tx.from_location || null,
        to_location: tx.to_location || null,
        status: tx.status || 'completed',
        supplier_container: tx.supplier_container || '',
        employee_id: tx.employee_id,
        notes: tx.notes || '',
        created_at: tx.created_at || new Date().toISOString()
      }).select().single();

      if (txError) throw txError;

      let stockUpdateResult = null;
      if (tx.transaction_type === 'receive' && tx.status === 'completed') {
        stockUpdateResult = await serverUpdateStockLevel(supabase, skuKey, tx.product_type, tx.to_location, tx.quantity);
      } else if (tx.transaction_type === 'transfer' && tx.status === 'completed') {
        const subRes = await serverUpdateStockLevel(supabase, skuKey, tx.product_type, tx.from_location, -tx.quantity);
        const addRes = await serverUpdateStockLevel(supabase, skuKey, tx.product_type, tx.to_location, tx.quantity);
        stockUpdateResult = { subRes, addRes };
      } else if (tx.transaction_type === 'transfer' && tx.status === 'pending') {
        stockUpdateResult = await serverUpdateStockLevel(supabase, skuKey, tx.product_type, tx.from_location, -tx.quantity);
      }

      return res.status(200).json({ 
        success: true, 
        transaction: insertedData,
        stockUpdate: stockUpdateResult 
      });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // --- ACTION 2: EDIT TRANSACTION (Manager Override) ---
  if (action === 'edit') {
    const { transactionId, newQuantity, notes, managerPin } = body;
    const pinCheck = verifyAdminPassword(managerPin);
    if (!pinCheck.configured) {
      return res.status(503).json({ error: 'Manager override is not configured.' });
    }
    if (!pinCheck.ok) {
      return res.status(401).json({ error: 'Invalid Manager Override PIN. Access denied.' });
    }

    if (!transactionId || typeof newQuantity !== 'number' || newQuantity <= 0) {
      return res.status(400).json({ error: 'Missing or invalid parameters (transactionId, newQuantity)' });
    }

    try {
      const { data: tx, error: fetchErr } = await supabase
        .from('inventory_transactions')
        .select('*')
        .eq('id', transactionId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!tx) return res.status(404).json({ error: 'Transaction not found' });

      const diff = newQuantity - tx.quantity;

      let stockUpdateResult = null;
      if (tx.transaction_type === 'receive' && tx.status === 'completed') {
        stockUpdateResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, diff);
      } else if (tx.transaction_type === 'transfer' && tx.status === 'completed') {
        const subSrc = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, -diff);
        const addDest = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, diff);
        stockUpdateResult = { subSrc, addDest };
      } else if (tx.transaction_type === 'transfer' && tx.status === 'pending') {
        stockUpdateResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, -diff);
      }

      const { data: updatedTx, error: updateErr } = await supabase
        .from('inventory_transactions')
        .update({ quantity: newQuantity, notes: notes || tx.notes })
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
      return res.status(500).json({ error: error.message });
    }
  }

  // --- ACTION 3: UNDO TRANSACTION (Manager Override Delete) ---
  if (action === 'undo') {
    const { transactionId, managerPin } = body;
    const pinCheck = verifyAdminPassword(managerPin);
    if (!pinCheck.configured) {
      return res.status(503).json({ error: 'Manager override is not configured.' });
    }
    if (!pinCheck.ok) {
      return res.status(401).json({ error: 'Invalid Manager Override PIN. Access denied.' });
    }

    if (!transactionId) {
      return res.status(400).json({ error: 'Missing transactionId parameter' });
    }

    try {
      const { data: tx, error: fetchErr } = await supabase
        .from('inventory_transactions')
        .select('*')
        .eq('id', transactionId)
        .maybeSingle();

      if (fetchErr) throw fetchErr;
      if (!tx) return res.status(404).json({ error: 'Transaction not found' });

      let stockRevertResult = null;
      if (tx.transaction_type === 'receive' && tx.status === 'completed') {
        stockRevertResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, -tx.quantity);
      } else if (tx.transaction_type === 'transfer' && tx.status === 'completed') {
        const addSrc = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, tx.quantity);
        const subDest = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, -tx.quantity);
        stockRevertResult = { addSrc, subDest };
      } else if (tx.transaction_type === 'transfer' && tx.status === 'pending') {
        stockRevertResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, tx.quantity);
      }

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
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action parameter' });
}
