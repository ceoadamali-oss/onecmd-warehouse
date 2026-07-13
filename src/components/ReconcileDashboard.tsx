import { useState, useEffect } from 'react';
import { 
  ArrowLeft, 
  RotateCw, 
  ChevronDown, 
  ChevronUp, 
  Calendar, 
  ShoppingCart, 
  BarChart3 
} from 'lucide-react';
import { authHeaders } from '../staffAuth';

interface ReconcileDashboardProps {
  onBack: () => void;
  showTemporaryMessage: (type: 'success' | 'error', text: string) => void;
}

interface SummaryRow {
  id: string;
  name: string;
  scanned: number;
  deductions: number;
  live: number;
}

interface DeductionDetail {
  order_id: string;
  date: string;
  name: string;
  sku: string;
  qty: number;
}

export function ReconcileDashboard({ onBack, showTemporaryMessage }: ReconcileDashboardProps) {
  const [loading, setLoading] = useState(true);
  const [summary, setSummary] = useState<SummaryRow[]>([]);
  const [details, setDetails] = useState<Record<string, DeductionDetail[]>>({});
  const [expandedLoc, setExpandedLoc] = useState<string | null>(null);

  const fetchReconciliationData = async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/live-reconciliation', {
        headers: authHeaders()
      });
      if (!res.ok) {
        throw new Error(`API returned ${res.status}`);
      }
      const data = await res.json();
      if (data.success) {
        setSummary(data.summary || []);
        setDetails(data.details || {});
      } else {
        throw new Error(data.error || 'Unknown API error');
      }
    } catch (err: any) {
      showTemporaryMessage('error', `Failed to load reconciliation: ${err.message}`);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchReconciliationData();
  }, []);

  const toggleExpand = (locId: string) => {
    if (expandedLoc === locId) {
      setExpandedLoc(null);
    } else {
      setExpandedLoc(locId);
    }
  };

  return (
    <div className="space-y-6 max-w-5xl mx-auto p-4 pb-20">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button 
            onClick={onBack}
            className="p-2 rounded-lg bg-white/5 border border-glass text-gray-400 hover:text-white transition-all"
            title="Back to Dashboard"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div>
            <h1 className="text-xl font-bold text-white flex items-center gap-2">
              <BarChart3 className="w-6 h-6 text-rose-500 animate-pulse" />
              Live Stock Reconciliation
            </h1>
            <p className="text-xs text-gray-400">
              Audit baseline counts against live Square sales transactions since July 12
            </p>
          </div>
        </div>

        <button 
          onClick={fetchReconciliationData}
          disabled={loading}
          className="btn-secondary py-2 px-3 flex items-center gap-2"
        >
          <RotateCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Refreshing...' : 'Refresh'}
        </button>
      </div>

      {loading ? (
        <div className="glass-panel flex flex-col items-center justify-center p-16 space-y-4">
          <RotateCw className="w-8 h-8 text-rose-500 animate-spin" />
          <span className="text-sm text-gray-400">Querying live sales data and matching stock...</span>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Summary Table */}
          <div className="glass-panel overflow-hidden border border-glass">
            <div className="p-4 border-b border-glass bg-white/5">
              <h2 className="text-sm font-semibold text-white">Store Inventory Audit</h2>
            </div>
            
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="border-b border-glass bg-black/20 text-xs text-gray-400 font-semibold">
                    <th className="p-3.5">Store Location</th>
                    <th className="p-3.5 text-center">Scanned Baseline</th>
                    <th className="p-3.5 text-center">Post-Scan Sales</th>
                    <th className="p-3.5 text-center">Live Reconciled Stock</th>
                    <th className="p-3.5 text-center">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {summary.map((row) => {
                    const isExpanded = expandedLoc === row.id;
                    const itemsDetail = details[row.id] || [];

                    return (
                      <>
                        <tr 
                          key={row.id}
                          onClick={() => toggleExpand(row.id)}
                          className="border-b border-glass/40 hover:bg-white/5 transition-all cursor-pointer"
                        >
                          <td className="p-3.5">
                            <span className="font-semibold text-sm text-slate-100 block">{row.name}</span>
                            <span className="text-[10px] text-gray-500 uppercase tracking-wider">{row.id}</span>
                          </td>
                          <td className="p-3.5 text-center font-medium text-slate-200">
                            {row.scanned}
                          </td>
                          <td className="p-3.5 text-center font-medium text-rose-400">
                            {row.deductions}
                          </td>
                          <td className="p-3.5 text-center">
                            <span className="inline-flex items-center justify-center px-2.5 py-1 rounded-full bg-cyan-500/10 border border-cyan-500/20 text-cyan-400 text-xs font-bold">
                              {row.live} units
                            </span>
                          </td>
                          <td className="p-3.5 text-center">
                            <button 
                              type="button"
                              className="p-1.5 rounded bg-white/5 border border-glass text-gray-400 hover:text-white"
                            >
                              {isExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                            </button>
                          </td>
                        </tr>

                        {/* Expandable Box */}
                        {isExpanded && (
                          <tr>
                            <td colSpan={5} className="p-0 bg-black/40 border-b border-glass">
                              <div className="p-4 space-y-3 max-h-[350px] overflow-y-auto">
                                <div className="flex items-center justify-between">
                                  <span className="text-xs font-bold text-gray-400 uppercase tracking-wider flex items-center gap-1.5">
                                    <ShoppingCart className="w-3.5 h-3.5 text-rose-400" />
                                    Sales Transactions Log ({itemsDetail.length} items)
                                  </span>
                                </div>

                                {itemsDetail.length === 0 ? (
                                  <div className="text-center py-6 text-xs text-gray-500 border border-dashed border-glass rounded-xl">
                                    No sales transactions recorded since the scan completion timestamp.
                                  </div>
                                ) : (
                                  <div className="space-y-2">
                                    {itemsDetail.map((item, idx) => (
                                      <div 
                                        key={`${item.order_id}-${idx}`}
                                        className="p-2.5 rounded-lg border border-glass bg-white/5 flex items-center justify-between text-xs transition-all hover:border-glass-hover"
                                      >
                                        <div className="space-y-1">
                                          <div className="font-semibold text-slate-200">{item.name}</div>
                                          <div className="flex items-center gap-3 text-[10px] text-gray-400">
                                            <span className="font-mono bg-white/5 px-1 py-0.5 rounded text-cyan-400">SKU: {item.sku}</span>
                                            <span>Order: {item.order_id.slice(0, 8)}...</span>
                                          </div>
                                        </div>

                                        <div className="text-right space-y-1">
                                          <div className="font-bold text-rose-400">-{item.qty} units</div>
                                          <div className="flex items-center gap-1 text-[9px] text-gray-500 justify-end">
                                            <Calendar className="w-2.5 h-2.5" />
                                            {new Date(item.date).toLocaleString([], { dateStyle: 'short', timeStyle: 'short' })}
                                          </div>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>
                            </td>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
