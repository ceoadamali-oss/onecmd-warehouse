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
  status: 'pending' | 'completed' | 'needs_correction' | 'corrected';
  created_at: string;
}

const OFFLINE_QUEUE_KEY = 'onecmd_offline_transactions';
const TOKEN_KEY = 'onecmd_staff_token';

function authHeaders(): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const token = sessionStorage.getItem(TOKEN_KEY);
    if (token) headers.Authorization = `Bearer ${token}`;
  } catch {
    /* ignore */
  }
  return headers;
}

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
        const response = await fetch('/api/transaction', {
          method: 'POST',
          headers: authHeaders(),
          body: JSON.stringify({ action: 'sync', tx })
        });

        if (!response.ok) {
          const errText = await response.text();
          throw new Error(`Sync API returned status ${response.status}: ${errText}`);
        }

        const resData = await response.json();
        if (!resData.success) {
          throw new Error(resData.error || 'Unknown API sync error');
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
