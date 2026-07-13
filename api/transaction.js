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

// Authoritative Inventory Write Path (H3-BLOCK)
async function serverUpdateStockLevel(supabaseClient, sku, type, locationId, diff, productId) {
  const activeLocalLocations = ['moncton', 'oromocto', 'saint-john', 'fredericton', 'otown'];
  if (!locationId || !activeLocalLocations.includes(locationId)) {
    console.log(`ℹ️ [API] Skipping stock update for non-local location: ${locationId}`);
    return null;
  }

  // Ensure product ID exists
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

  // Initialize stock for pending branches upon transaction (H3-BLOCK)
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

  if (!await requireStaffAuth(req, res)) return;

  const body = req.body || {};
  const action = body.action || 'sync';

  // --- ACTION 1: SYNC TRANSACTION (Receive / Move) ---
  if (action === 'sync') {
    const tx = body.tx ? body.tx : body;
    const newProduct = body.newProduct || null;

    if (!tx || !tx.sku || !tx.product_type || !tx.transaction_type || !tx.quantity) {
      return res.status(400).json({ error: 'Missing required transaction fields' });
    }

    const skuKeyInput = tx.sku.toUpperCase().trim();
    let skuKey = skuKeyInput;
    let productId = null;
    let skuRedirected = false;
    let aliasUsed = null;

    // Check confirmed active aliases
    try {
      const { data: aliasRecord } = await supabase
        .from('product_sku_aliases')
        .select('product_id, alias_sku, product_master ( master_sku )')
        .eq('alias_sku', skuKeyInput)
        .eq('status', 'active')
        .maybeSingle();

      if (aliasRecord) {
        productId = aliasRecord.product_id;
        skuKey = aliasRecord.product_master?.master_sku || skuKey;
        skuRedirected = true;
        aliasUsed = skuKeyInput;
      } else {
        const { data: masterRecord } = await supabase
          .from('product_master')
          .select('id')
          .eq('master_sku', skuKeyInput)
          .maybeSingle();
        
        if (masterRecord) {
          productId = masterRecord.id;
        }
      }
    } catch (err) {
      console.warn('Failed to resolve SKU redirect:', err.message);
    }

    const isWheel = tx.product_type === 'wheel';
    const table = isWheel ? 'wheels_catalog' : 'tires_catalog';

    try {
      // 1. Create or Update details in authoritative product_master first
      let catalogName = `Received Catalog SKU: ${skuKey}`;
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
      }

      if (!productId) {
        let basePrice = isWheel ? 180 : 120;
        if (!isWheel && newProduct) {
          try {
            const { data: sameSizeTires } = await supabase
              .from('product_master')
              .select('price')
              .eq('size', sizeValue)
              .eq('product_type', 'tire')
              .not('price', 'is', null);
            if (sameSizeTires && sameSizeTires.length > 0) {
              const sum = sameSizeTires.reduce((acc, curr) => acc + (Number(curr.price) || 0), 0);
              basePrice = Math.round((sum / sameSizeTires.length) * 100) / 100;
            }
          } catch (e) {
            console.warn('Failed to calculate average price for size:', sizeValue);
          }
        }

        if (!isWheel && newProduct && newProduct.preStudded) {
          basePrice += 25.00;
        }

        const { data: newPM, error: pmErr } = await supabase
          .from('product_master')
          .insert({
            product_type: tx.product_type,
            master_sku: skuKey,
            brand: brandName,
            model: newProduct ? newProduct.model : 'Generic Product',
            size: sizeValue,
            price: basePrice,
            stock: 0,
            winter_approved: winterApprovedVal,
            specifications: newProduct ? { ...newProduct } : {},
            inventory_status: 'pending',
            version: 1
          })
          .select('id')
          .single();

        if (!pmErr && newPM) {
          productId = newPM.id;
        }
      } else {
        await supabase
          .from('product_master')
          .update({
            brand: brandName,
            model: newProduct ? newProduct.model : 'Generic Product',
            size: sizeValue,
            winter_approved: winterApprovedVal,
            updated_at: new Date().toISOString()
          })
          .eq('id', productId);
      }

      // 2. Keep tires_catalog/wheels_catalog mirror updated
      const { data: existingItem } = await supabase
        .from(table)
        .select('sku, brand, name, size, image')
        .eq('sku', skuKey)
        .maybeSingle();

      let publicImageUrl = existingItem ? existingItem.image : '';

      if (newProduct && newProduct.productPhoto) {
        try {
          const buffer = base64ToBuffer(newProduct.productPhoto);
          const filePath = `${skuKey}.jpg`;
          await supabase.storage.createBucket('product-images', { public: true }).catch(() => {});
          const { error: uploadErr } = await supabase.storage
            .from('product-images')
            .upload(filePath, buffer, { contentType: 'image/jpeg', upsert: true });

          if (!uploadErr) {
            const { data: urlData } = supabase.storage.from('product-images').getPublicUrl(filePath);
            publicImageUrl = urlData.publicUrl;
          }
        } catch (imgErr) {
          console.error("Image upload failed:", imgErr);
        }
      }

      const catalogPayload = {
        sku: skuKey,
        brand: brandName,
        size: sizeValue,
        name: catalogName,
        price: isWheel ? 180 : 120,
        image: publicImageUrl || (existingItem ? existingItem.image : ''),
        location_counts: existingItem ? existingItem.location_counts : {}
      };
      if (!isWheel) catalogPayload.type = typeValue;


      await supabase.from(table).upsert(catalogPayload);

      // 3. Write transaction log
      const { data: insertedData, error: txError } = await supabase.from('inventory_transactions').insert({
        id: tx.id || undefined,
        sku: skuKey,
        product_type: tx.product_type,
        transaction_type: tx.transaction_type,
        quantity: tx.quantity,
        from_location: tx.from_location || null,
        to_location: tx.to_location || null,
        status: tx.status || 'completed',
        employee_id: tx.employee_id,
        notes: tx.notes || '',
        created_at: tx.created_at || new Date().toISOString(),
        product_id: productId,
        original_sku: skuKeyInput,
        resolved_master_sku: skuKey,
        sku_redirected: skuRedirected,
        alias_used: aliasUsed
      }).select().single();

      if (txError) throw txError;

      // 4. Update stock inside authoritative PLI
      let stockUpdateResult = null;
      if (tx.transaction_type === 'receive' && tx.status === 'completed') {
        stockUpdateResult = await serverUpdateStockLevel(supabase, skuKey, tx.product_type, tx.to_location, tx.quantity, productId);
      } else if (tx.transaction_type === 'transfer' && tx.status === 'completed') {
        const subRes = await serverUpdateStockLevel(supabase, skuKey, tx.product_type, tx.from_location, -tx.quantity, productId);
        const addRes = await serverUpdateStockLevel(supabase, skuKey, tx.product_type, tx.to_location, tx.quantity, productId);
        stockUpdateResult = { subRes, addRes };
      } else if (tx.transaction_type === 'transfer' && tx.status === 'pending') {
        stockUpdateResult = await serverUpdateStockLevel(supabase, skuKey, tx.product_type, tx.from_location, -tx.quantity, productId);
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

  // --- ACTION 1B: SUBMIT TRANSFER BATCH ---
  if (action === 'transfer_batch') {
    const { transferGroupId, fromLocation, toLocation, employeeId, notes, managerOverride, managerId, overrideReason, items } = body;
    if (!transferGroupId || !fromLocation || !toLocation || !employeeId || !items || !Array.isArray(items)) {
      return res.status(400).json({ error: 'Missing required transfer batch parameters.' });
    }

    try {
      const { data, error } = await supabase.rpc('submit_transfer_batch', {
        p_transfer_group_id: transferGroupId,
        p_from_location: fromLocation,
        p_to_location: toLocation,
        p_employee_id: employeeId,
        p_notes: notes || '',
        p_manager_override: !!managerOverride,
        p_manager_id: managerId || null,
        p_override_reason: overrideReason || null,
        p_items: items
      });

      if (error) throw error;
      return res.status(200).json(data);
    } catch (error) {
      console.error('❌ [API Serverless] Submit transfer batch failed:', error.message);
      return res.status(500).json({ error: error.message });
    }
  }

  // --- ACTION 2: EDIT TRANSACTION ---
  if (action === 'edit') {
    const { transactionId, newQuantity, notes, managerPin } = body;
    const pinCheck = verifyAdminPassword(managerPin);
    if (!pinCheck.configured || !pinCheck.ok) {
      return res.status(401).json({ error: 'Access denied.' });
    }

    try {
      const { data: tx } = await supabase.from('inventory_transactions').select('*').eq('id', transactionId).maybeSingle();
      if (!tx) return res.status(404).json({ error: 'Transaction not found' });

      const diff = newQuantity - tx.quantity;

      let stockUpdateResult = null;
      if (tx.transaction_type === 'receive' && tx.status === 'completed') {
        stockUpdateResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, diff, tx.product_id);
      } else if (tx.transaction_type === 'transfer' && tx.status === 'completed') {
        const subSrc = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, -diff, tx.product_id);
        const addDest = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, diff, tx.product_id);
        stockUpdateResult = { subSrc, addDest };
      } else if (tx.transaction_type === 'transfer' && tx.status === 'pending') {
        stockUpdateResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, -diff, tx.product_id);
      }

      const { data: updatedTx } = await supabase
        .from('inventory_transactions')
        .update({ quantity: newQuantity, notes: notes || tx.notes })
        .eq('id', transactionId)
        .select()
        .single();

      return res.status(200).json({ success: true, transaction: updatedTx, stockUpdate: stockUpdateResult });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  // --- ACTION 3: UNDO TRANSACTION ---
  if (action === 'undo') {
    const { transactionId, managerPin } = body;
    const pinCheck = verifyAdminPassword(managerPin);
    if (!pinCheck.configured || !pinCheck.ok) {
      return res.status(401).json({ error: 'Access denied.' });
    }

    try {
      const { data: tx } = await supabase.from('inventory_transactions').select('*').eq('id', transactionId).maybeSingle();
      if (!tx) return res.status(404).json({ error: 'Transaction not found' });

      let stockRevertResult = null;
      if (tx.transaction_type === 'receive' && tx.status === 'completed') {
        stockRevertResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, -tx.quantity, tx.product_id);
      } else if (tx.transaction_type === 'transfer' && tx.status === 'completed') {
        const addSrc = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, tx.quantity, tx.product_id);
        const subDest = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.to_location, -tx.quantity, tx.product_id);
        stockRevertResult = { addSrc, subDest };
      } else if (tx.transaction_type === 'transfer' && tx.status === 'pending') {
        stockRevertResult = await serverUpdateStockLevel(supabase, tx.sku, tx.product_type, tx.from_location, tx.quantity, tx.product_id);
      }

      await supabase.from('inventory_transactions').delete().eq('id', transactionId);
      return res.status(200).json({ success: true, revertedTransaction: tx, stockRevert: stockRevertResult });
    } catch (error) {
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(400).json({ error: 'Invalid action parameter' });
}
