import { createClient } from '@supabase/supabase-js';
import { requireStaffAuth } from './_auth.js';

const SQUARE_ACCESS_TOKEN = process.env.SQUARE_ACCESS_TOKEN;
const supabaseUrl = process.env.VITE_SUPABASE_URL || '';
const supabaseServiceKey = process.env.VITE_SUPABASE_SERVICE_ROLE_KEY || '';
const supabase = (supabaseUrl && supabaseServiceKey) ? createClient(supabaseUrl, supabaseServiceKey) : null;

const STORES = {
  'L72FDHCQVM9DH': 'Tire King Moncton',
  'L1674TX09B97B': 'Atlantic Tire King (Oromocto)',
  'LVBRMYPFKX63J': 'Saint John Store',
  'L11QTEBW25AW6': 'Fredericton Store'
};

const dbLocationKeys = {
  'L72FDHCQVM9DH': 'moncton',
  'L1674TX09B97B': 'oromocto',
  'LVBRMYPFKX63J': 'saint-john',
  'L11QTEBW25AW6': 'fredericton'
};

function normalizeText(text) {
  return (text || '').replace(/\\/g, '').replace(/\//g, '').replace(/\s+/g, '').replace(/-/g, '').replace(/\./g, '').toLowerCase();
}

function cleanSizeForMatching(sz) {
  return sz.replace(/[^0-9]/g, '');
}

async function squareRequest(path, method = 'GET', body = null) {
  const url = `https://connect.squareup.com/v2${path}`;
  const headers = {
    'Authorization': `Bearer ${SQUARE_ACCESS_TOKEN}`,
    'Square-Version': '2024-03-20',
    'Content-Type': 'application/json'
  };

  const options = {
    method,
    headers
  };

  if (body) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Square API Failed: ${method} ${path} -> ${response.status} - ${errorText}`);
  }
  return await response.json();
}

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  if (!supabase) {
    return res.status(500).json({ error: 'Database configuration missing' });
  }

  if (!await requireStaffAuth(req, res)) return;

  const { action, query } = req.query || {};

  // --- ACTION 1: SEARCH CATALOG ---
  if (action === 'search') {
    if (!query || !query.trim()) {
      return res.status(200).json([]);
    }

    try {
      const cleanQuery = query.trim();
      let orFilter = `master_sku.ilike.%${cleanQuery}%,brand.ilike.%${cleanQuery}%,model.ilike.%${cleanQuery}%,size.ilike.%${cleanQuery}%`;
      
      const sizeParts = cleanQuery.match(/\d+/g);
      if (sizeParts && sizeParts.length >= 2) {
        const sizeWildcard = sizeParts.join('%');
        orFilter += `,size.ilike.%${sizeWildcard}%`;
      }

      const { data, error } = await supabase
        .from('product_master')
        .select('*, product_location_inventory(*)')
        .or(orFilter)
        .limit(40);

      if (error) throw error;
      return res.status(200).json(data || []);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // --- ACTION 2: LIVE RECONCILIATION SUMMARY ---
  if (action === 'reconcile') {
    try {
      if (!SQUARE_ACCESS_TOKEN) {
        return res.status(500).json({ error: 'Square token not configured' });
      }

      // Fetch catalog to map Variation IDs to SKUs
      let catalogItems = [];
      let cursor = null;
      do {
        const path = cursor ? `/catalog/list?types=ITEM&cursor=${cursor}` : '/catalog/list?types=ITEM';
        const result = await squareRequest(path);
        if (result.objects) {
          catalogItems = catalogItems.concat(result.objects);
        }
        cursor = result.cursor;
      } while (cursor);

      const variationIdToSku = {};
      for (const item of catalogItems) {
        const variations = item.item_data.variations || [];
        for (const v of variations) {
          if (v.item_variation_data && v.item_variation_data.sku) {
            variationIdToSku[v.id] = v.item_variation_data.sku.toUpperCase().trim();
          }
        }
      }

      // Fetch products from Supabase
      const { data: dbProducts, error: pErr } = await supabase
        .from('product_master')
        .select('*')
        .eq('status', 'active');
      if (pErr) throw pErr;

      // Fetch physical scan inventory counts
      let allInvRows = [];
      let start = 0;
      const pageSize = 1000;
      while (true) {
        const { data, error } = await supabase
          .from('product_location_inventory')
          .select('*')
          .range(start, start + pageSize - 1);
        if (error) throw error;
        if (!data || data.length === 0) break;
        allInvRows = allInvRows.concat(data);
        if (data.length < pageSize) break;
        start += pageSize;
      }

      const scannedInventory = {};
      allInvRows.forEach(inv => {
        if (!scannedInventory[inv.product_id]) scannedInventory[inv.product_id] = {};
        scannedInventory[inv.product_id][inv.location_id] = inv.quantity || 0;
      });

      const productsBySku = {};
      dbProducts.forEach(p => {
        const sku = p.master_sku.toUpperCase().trim();
        productsBySku[sku] = p;
      });

      // Fetch orders since scan completion
      const scanCompletionTime = '2026-07-12T05:29:52Z';
      const storeIds = Object.keys(STORES);
      
      const ordersRes = await squareRequest('/orders/search', 'POST', {
        location_ids: storeIds,
        query: {
          filter: {
            date_time_filter: {
              created_at: {
                start_at: scanCompletionTime
              }
            },
            state_filter: {
              states: ['COMPLETED', 'OPEN']
            }
          },
          sort: {
            sort_field: 'CREATED_AT',
            sort_order: 'DESC'
          }
        },
        limit: 500
      });

      const scannedTotals = {
        'L72FDHCQVM9DH': 0,
        'L1674TX09B97B': 0,
        'LVBRMYPFKX63J': 0,
        'L11QTEBW25AW6': 0
      };

      dbProducts.forEach(p => {
        Object.keys(dbLocationKeys).forEach(locId => {
          const dbLocKey = dbLocationKeys[locId];
          const scannedQty = (scannedInventory[p.id] || {})[dbLocKey] || 0;
          scannedTotals[locId] += scannedQty;
        });
      });

      const deductionsByStore = {
        'L72FDHCQVM9DH': [],
        'L1674TX09B97B': [],
        'LVBRMYPFKX63J': [],
        'L11QTEBW25AW6': []
      };

      const orders = ordersRes.orders || [];

      for (const order of orders) {
        const locName = STORES[order.location_id]?.toLowerCase() || '';
        let locId = null;
        if (locName.includes('moncton')) locId = 'L72FDHCQVM9DH';
        else if (locName.includes('oromocto') || locName.includes('atlantic')) locId = 'L1674TX09B97B';
        else if (locName.includes('saint') || locName.includes('st') || locName.includes('john')) locId = 'LVBRMYPFKX63J';
        else if (locName.includes('fredericton')) locId = 'L11QTEBW25AW6';

        if (!locId) continue;

        const lineItems = order.line_items || [];
        for (const item of lineItems) {
          const qty = parseInt(item.quantity, 10) || 0;
          if (qty <= 0) continue;

          let matchedProduct = null;
          const skuFromVarId = variationIdToSku[item.catalog_object_id];
          if (skuFromVarId) {
            matchedProduct = productsBySku[skuFromVarId];
          }

          if (!matchedProduct && item.name) {
            const text = normalizeText(item.name);
            const textNums = text.replace(/[^0-9]/g, '');
            matchedProduct = dbProducts.find(p => {
              const model = normalizeText(p.model);
              const sizeNums = cleanSizeForMatching(p.size);
              return text.includes(model) && textNums.includes(sizeNums);
            });
          }

          if (!matchedProduct && item.name) {
            const n = normalizeText(item.name);
            if (n.includes('battlefield') && n.includes('27560')) {
              matchedProduct = productsBySku['VETERAN-275-6020-BATTLEFIELD-XT'];
            } else if (n.includes('ev7') && n.includes('25550')) {
              matchedProduct = productsBySku['CENTARA-255-5020-E-VANTI-EV7'];
            }
          }

          const isInstall = item.name && (item.name.toLowerCase().includes('install') || item.name.toLowerCase().includes('balance'));
          if (isInstall) continue;

          if (matchedProduct) {
            const sku = matchedProduct.master_sku;
            deductionsByStore[locId].push({
              order_id: order.id,
              date: order.created_at,
              name: `${matchedProduct.brand} ${matchedProduct.model} (${matchedProduct.size})`,
              sku,
              qty
            });
          } else if (item.name && item.catalog_object_id) {
            deductionsByStore[locId].push({
              order_id: order.id,
              date: order.created_at,
              name: item.name,
              sku: 'UNMATCHED',
              qty
            });
          }
        }
      }

      const summary = Object.entries(STORES).map(([id, name]) => {
        const scanned = scannedTotals[id] || 0;
        const deductionsTotal = deductionsByStore[id].reduce((acc, curr) => acc + curr.qty, 0);
        const live = Math.max(0, scanned - deductionsTotal);
        
        return {
          id,
          name,
          scanned,
          deductions: -deductionsTotal,
          live
        };
      });

      return res.status(200).json({
        success: true,
        summary,
        details: deductionsByStore
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  // --- ACTION 3: PENDING TRANSFERS ---
  if (action === 'pending-transfers') {
    const { locationId } = req.query || {};
    if (!locationId) {
      return res.status(400).json({ error: 'locationId is required' });
    }
    try {
      const { data, error } = await supabase
        .from('inventory_transactions')
        .select('*')
        .eq('to_location', locationId)
        .eq('status', 'pending');
      if (error) throw error;
      return res.status(200).json(data || []);
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Invalid or missing action parameter' });
}
