import { supabase } from './supabaseClient';

export interface PendingTransaction {
  id: string;
  sku: string;
  product_type: 'tire' | 'wheel';
  transaction_type: 'receive' | 'transfer';
  quantity: number;
  from_location?: string;
  to_location?: string;
  supplier_container?: string;
  employee_id: string;
  notes?: string;
  status: 'pending' | 'completed';
  created_at: string;
}

const OFFLINE_QUEUE_KEY = 'onecmd_offline_transactions';

export const offlineStorage = {
  // Get all pending transactions stored locally
  getQueue(): PendingTransaction[] {
    try {
      const data = localStorage.getItem(OFFLINE_QUEUE_KEY);
      return data ? JSON.parse(data) : [];
    } catch (e) {
      console.error('Failed to parse offline transactions queue:', e);
      return [];
    }
  },

  // Save transaction to local offline queue
  enqueue(tx: Omit<PendingTransaction, 'id' | 'created_at'>): void {
    const queue = this.getQueue();
    const newTx: PendingTransaction = {
      ...tx,
      id: crypto.randomUUID ? crypto.randomUUID() : Math.random().toString(36).substring(2),
      created_at: new Date().toISOString()
    };
    queue.push(newTx);
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(queue));
  },

  // Remove a transaction from the queue by ID
  dequeue(id: string): void {
    const queue = this.getQueue();
    const filtered = queue.filter(item => item.id !== id);
    localStorage.setItem(OFFLINE_QUEUE_KEY, JSON.stringify(filtered));
  },

  // Clear the entire queue
  clearQueue(): void {
    localStorage.removeItem(OFFLINE_QUEUE_KEY);
  },

  // Attempts to sync all offline items with Supabase
  async syncQueue(): Promise<{ success: number; failed: number }> {
    const queue = this.getQueue();
    if (queue.length === 0) return { success: 0, failed: 0 };

    let successCount = 0;
    let failedCount = 0;

    console.log(`🔄 Attempting to sync ${queue.length} offline transactions...`);

    for (const tx of queue) {
      try {
        // 1. Upload transaction to database
        const { error: txError } = await supabase.from('inventory_transactions').insert({
          id: tx.id,
          sku: tx.sku,
          product_type: tx.product_type,
          transaction_type: tx.transaction_type,
          quantity: tx.quantity,
          from_location: tx.from_location,
          to_location: tx.to_location,
          status: tx.status,
          supplier_container: tx.supplier_container,
          employee_id: tx.employee_id,
          notes: tx.notes || 'Submitted offline',
          created_at: tx.created_at
        });

        if (txError) throw txError;

        // 2. Update actual inventory catalog stock
        if (tx.transaction_type === 'receive' && tx.status === 'completed') {
          // Adjust stock directly for receiving (we will do this in the app handler)
          await updateStockLevel(tx.sku, tx.product_type, tx.to_location!, tx.quantity);
        } else if (tx.transaction_type === 'transfer' && tx.status === 'completed') {
          // Subtract from source, add to dest (for completed direct transfers)
          await updateStockLevel(tx.sku, tx.product_type, tx.from_location!, -tx.quantity);
          await updateStockLevel(tx.sku, tx.product_type, tx.to_location!, tx.quantity);
        } else if (tx.transaction_type === 'transfer' && tx.status === 'pending') {
          // In-transit transfer handshake: subtract from source, but do NOT add to dest yet
          await updateStockLevel(tx.sku, tx.product_type, tx.from_location!, -tx.quantity);
        }

        // Successfully synced, dequeue it
        this.dequeue(tx.id);
        successCount++;
      } catch (err) {
        console.error(`❌ Failed to sync transaction ${tx.id}:`, err);
        failedCount++;
      }
    }

    return { success: successCount, failed: failedCount };
  }
};

// Helper function to update catalog stock values inside Supabase jsonb
export async function updateStockLevel(sku: string, type: 'tire' | 'wheel', locationId: string, diff: number) {
  const table = type === 'tire' ? 'tires_catalog' : 'wheels_catalog';
  
  // 1. Fetch current item location counts
  const { data, error } = await supabase
    .from(table)
    .select('location_counts, stock')
    .eq('sku', sku)
    .single();

  if (error || !data) return;

  const currentCounts = data.location_counts || {};

  const newLocCount = Math.max(0, (currentCounts[locationId] || 0) + diff);
  const newCounts = {
    ...currentCounts,
    [locationId]: newLocCount
  };

  // Calculate new total stock by summing up all locations
  const newTotal = Object.values(newCounts).reduce((a: number, b: any) => a + (parseInt(b) || 0), 0);

  // 2. Save new values
  await supabase
    .from(table)
    .update({
      location_counts: newCounts,
      stock: newTotal
    })
    .eq('sku', sku);
}
