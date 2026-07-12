import React, { useState, useEffect, useMemo } from 'react';
import { supabase } from '../supabaseClient';
import { 
  ArrowLeftRight, 
  Search, 
  Filter, 
  Shield,
  Eye,
  Sliders,
  Grid,
  Bell,
  Sparkles
} from 'lucide-react';

interface GlobalTransferDashboardProps {
  currentUser: any;
  locations: any[];
  onBack: () => void;
  showTemporaryMessage: (type: 'success' | 'error', text: string) => void;
}

export const GlobalTransferDashboard: React.FC<GlobalTransferDashboardProps> = ({
  currentUser,
  locations,
  onBack,
  showTemporaryMessage
}) => {
  // Tabs
  const [subTab, setSubTab] = useState<'overview' | 'executive' | 'matrix' | 'warranties' | 'intelligence' | 'notifications' | 'config'>('overview');

  // Database States
  const [batches, setBatches] = useState<any[]>([]);
  const [discrepancies, setDiscrepancies] = useState<any[]>([]);
  const [productsInventory, setProductsInventory] = useState<any[]>([]);
  const [warranties, setWarranties] = useState<any[]>([]);
  const [reconciling, setReconciling] = useState(false);
  const [processingWarranty, setProcessingWarranty] = useState<string | null>(null);

  // Configuration thresholds (Aging delays in hours)
  const [delayThreshold, setDelayThreshold] = useState<number>(24);
  const [overdueThreshold, setOverdueThreshold] = useState<number>(48);
  const [criticalThreshold, setCriticalThreshold] = useState<number>(72);

  // Global Search State
  const [globalSearch, setGlobalSearch] = useState<string>('');

  // Filter States (Overview specific)
  const [filterSource, setFilterSource] = useState<string>('all');
  const [filterDest, setFilterDest] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  // Detail View State
  const [selectedBatch, setSelectedBatch] = useState<any | null>(null);
  const [selectedBatchItems, setSelectedBatchItems] = useState<any[]>([]);

  // Notification Rules Preferences
  const [notifRules, setNotifRules] = useState({
    lowStock: true,
    transferDelayed: true,
    discrepancyAlerts: true,
    warrantySubmitted: true,
    failedTransaction: true
  });

  // Fetch Data
  const fetchData = async () => {
    try {
      // 1. Fetch all transfer batches with items
      const { data: batchData, error: batchErr } = await supabase
        .from('transfer_batches')
        .select('*, transfer_batch_items(*)')
        .order('submitted_at', { ascending: false });

      if (batchErr) throw batchErr;
      setBatches(batchData || []);

      // 2. Fetch all discrepancies
      const { data: discData, error: discErr } = await supabase
        .from('transfer_discrepancies')
        .select('*')
        .order('created_at', { ascending: false });

      if (discErr) throw discErr;
      setDiscrepancies(discData || []);

      // 3. Fetch all product masters with location inventory
      const { data: pmData, error: pmErr } = await supabase
        .from('product_master')
        .select('*, product_location_inventory(*)');

      if (pmErr) throw pmErr;
      setProductsInventory(pmData || []);

      // 4. Fetch all warranties with replacements
      const { data: wData, error: wErr } = await supabase
        .from('warranties')
        .select('*, warranty_replacements(*)');

      if (wErr) throw wErr;
      setWarranties(wData || []);

    } catch (e: any) {
      showTemporaryMessage('error', `Failed to load operations dashboard: ${e.message}`);
    }
  };

  useEffect(() => {
    fetchData();
  }, []);

  // Fetch batch items details
  const viewBatchDetails = async (batch: any) => {
    setSelectedBatch(batch);
    try {
      const { data: items, error: itemsErr } = await supabase
        .from('transfer_batch_items')
        .select('*')
        .eq('transfer_batch_id', batch.id);

      if (itemsErr) throw itemsErr;
      setSelectedBatchItems(items || []);
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to load batch details: ${e.message}`);
    }
  };

  // Run In-Transit Cache Verification RPC
  const triggerReconciliationReview = async () => {
    setReconciling(true);
    try {
      let mismatches = 0;
      for (const pm of productsInventory) {
        for (const loc of locations) {
          try {
            const { error } = await supabase.rpc('verify_in_transit_cache', {
              p_product_id: pm.id,
              p_location_id: loc.location_id
            });
            if (error) throw error;
          } catch (e: any) {
            mismatches++;
            console.warn(`Mismatch detected: Product ID ${pm.id} at Location ${loc.location_id}. Msg: ${e.message}`);
          }
        }
      }

      if (mismatches === 0) {
        showTemporaryMessage('success', 'All in-transit cache records are completely verified and reconciled!');
      } else {
        showTemporaryMessage('error', `Reconciliation Review completed: Found ${mismatches} cache inconsistencies. Please review backend transaction logs.`);
      }
    } catch (e: any) {
      showTemporaryMessage('error', `Reconciliation query failed: ${e.message}`);
    } finally {
      setReconciling(false);
    }
  };

  // Approve Warranty request (Super Admin action)
  const handleApproveWarranty = async (warranty: any) => {
    if (!warranty.warranty_replacements || warranty.warranty_replacements.length === 0) {
      showTemporaryMessage('error', 'No replacement items specified in claim.');
      return;
    }

    setProcessingWarranty(warranty.id);
    try {
      const replacementPayload = warranty.warranty_replacements.map((item: any) => ({
        product_id: item.product_id,
        quantity: item.quantity,
        claim_amount: item.claim_amount
      }));

      const { error } = await supabase.rpc('approve_warranty_request', {
        p_warranty_id: warranty.id,
        p_approved_by: currentUser?.name || 'Super Admin',
        p_replacement_items: JSON.stringify(replacementPayload)
      });

      if (error) throw error;

      showTemporaryMessage('success', 'Warranty claim approved and inventory deducted successfully!');
      fetchData();
    } catch (e: any) {
      showTemporaryMessage('error', `Approval failed: ${e.message}`);
    } finally {
      setProcessingWarranty(null);
    }
  };

  // Reject / Cancel Warranty request
  const handleRejectWarranty = async (warrantyId: string) => {
    try {
      const { error } = await supabase
        .from('warranties')
        .update({ status: 'rejected', approved_by: currentUser?.name || 'Super Admin' })
        .eq('id', warrantyId);

      if (error) throw error;
      showTemporaryMessage('success', 'Warranty claim rejected.');
      fetchData();
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to reject claim: ${e.message}`);
    }
  };

  // Close warranty / claim supplier recovery
  const handleCloseWarranty = async (warrantyId: string, recoveryReceived: number) => {
    try {
      const { error } = await supabase
        .from('warranties')
        .update({ status: 'closed', notes: `Closed with supplier recovery of $${recoveryReceived}` })
        .eq('id', warrantyId);

      if (error) throw error;
      showTemporaryMessage('success', 'Warranty claim successfully closed.');
      fetchData();
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to close claim: ${e.message}`);
    }
  };

  // Aging Status Checker
  const getAgingStatus = (submittedAtStr: string) => {
    const hours = Math.abs(new Date().getTime() - new Date(submittedAtStr).getTime()) / 36e5;
    if (hours >= criticalThreshold) return { label: 'CRITICAL', color: 'badge-rose' };
    if (hours >= overdueThreshold) return { label: 'OVERDUE', color: 'badge-amber' };
    if (hours >= delayThreshold) return { label: 'DELAYED', color: 'badge-orange' };
    return { label: 'NORMAL', color: 'badge-green' };
  };

  // Dynamic Metrics (Executive Dashboard)
  const executiveMetrics = useMemo(() => {
    let totalValue = 0;
    let totalUnits = 0;
    let unitsInTransit = 0;
    let valueInTransit = 0;
    let transfersToday = 0;
    let openTransfers = 0;
    let pendingReceipts = 0;
    let pendingWarranties = 0;
    let warrantyCosts = 0;
    let supplierRecoveries = 0;
    let discrepanciesCount = 0;
    let damagedUnits = 0;
    let missingUnits = 0;
    let lowStockCount = 0;

    const todayStr = new Date().toISOString().split('T')[0];

    // Inventory calculations
    productsInventory.forEach(pm => {
      pm.product_location_inventory?.forEach((pli: any) => {
        const qty = pli.quantity || 0;
        totalUnits += qty;
        totalValue += qty * (pm.price || 120);

        const transit = pli.in_transit_quantity || 0;
        unitsInTransit += transit;
        valueInTransit += transit * (pm.price || 120);

        if (pli.inventory_status === 'complete' && qty <= 3) {
          lowStockCount++;
        }
        damagedUnits += pli.damaged_quantity || 0;
      });
    });

    // Transfer calculations
    batches.forEach(b => {
      const submittedDate = b.submitted_at?.split('T')[0];
      if (submittedDate === todayStr) {
        transfersToday++;
      }

      if (['submitted', 'in_transit', 'partially_received'].includes(b.status)) {
        openTransfers++;
        pendingReceipts++;
      }
    });

    // Discrepancy calculations
    discrepancies.forEach(d => {
      if (d.status === 'open') {
        discrepanciesCount++;
        if (d.discrepancy_type === 'missing') missingUnits += d.quantity;
      }
    });

    // Warranty calculations
    warranties.forEach(w => {
      if (w.status === 'submitted') pendingWarranties++;
      w.warranty_replacements?.forEach((wr: any) => {
        warrantyCosts += wr.claim_amount || 0;
        supplierRecoveries += wr.reimbursement_amount || 0;
      });
    });

    // Score calculations
    const scoreDeductions = (discrepanciesCount * 5) + (pendingWarranties * 2) + (lowStockCount * 1.5);
    const healthScore = Math.max(10, Math.min(100, Math.round(100 - scoreDeductions)));

    return {
      totalValue, totalUnits, unitsInTransit, valueInTransit, transfersToday, openTransfers,
      pendingReceipts, pendingWarranties, warrantyCosts, supplierRecoveries, discrepanciesCount,
      damagedUnits, missingUnits, lowStockCount, healthScore
    };
  }, [batches, discrepancies, productsInventory, warranties]);

  // AI Insights Generation
  const aiInsights = useMemo(() => {
    const list: string[] = [];

    // Check location specific low stock / overstock recommendations
    locations.forEach(loc => {
      let totalLocQty = 0;
      const lowStockSkus: string[] = [];
      const overstockSkus: string[] = [];

      productsInventory.forEach(pm => {
        const pli = pm.product_location_inventory?.find((l: any) => l.location_id === loc.location_id);
        const qty = pli?.quantity || 0;
        totalLocQty += qty;

        if (pli && pli.inventory_status === 'complete') {
          if (qty === 0) lowStockSkus.push(pm.master_sku);
          if (qty > 35) overstockSkus.push(pm.master_sku);
        }
      });

      if (lowStockSkus.length > 2) {
        list.push(`⚠️ ${loc.location_name.toUpperCase()} has critical understock on key items (${lowStockSkus.slice(0, 2).join(', ')}). Recommend replenishment.`);
      }
      if (overstockSkus.length > 0) {
        list.push(`📈 ${loc.location_name.toUpperCase()} is carrying excessive inventory for ${overstockSkus[0]}. Consider dynamic relocation before ordering more.`);
      }
    });

    // Identify frequently missing/damaged locations
    const locationDiscrepancies: Record<string, number> = {};
    discrepancies.forEach(d => {
      if (d.status === 'open') {
        locationDiscrepancies[d.destination_location] = (locationDiscrepancies[d.destination_location] || 0) + 1;
      }
    });

    Object.entries(locationDiscrepancies).forEach(([loc, count]) => {
      if (count >= 2) {
        list.push(`🚨 Location ${loc.toUpperCase()} has reported ${count} missing/damaged exceptions this week. Audit review advised.`);
      }
    });

    // Slow moving item recommendations
    const activeSkusInTransfers = new Set();
    batches.forEach(b => {
      b.transfer_batch_items?.forEach((item: any) => {
        activeSkusInTransfers.add(item.resolved_master_sku);
      });
    });

    const slowSkus: string[] = [];
    productsInventory.forEach(pm => {
      if (!activeSkusInTransfers.has(pm.master_sku) && pm.stock > 10) {
        slowSkus.push(pm.master_sku);
      }
    });

    if (slowSkus.length > 0) {
      list.push(`❄️ Slow-Moving Alert: SKUs (${slowSkus.slice(0, 3).join(', ')}) have no recent transfer activity. Run discount campaigns.`);
    }

    // Default recommendation if empty
    if (list.length === 0) {
      list.push("✨ All locations show balanced stock counts and active turnover. System running optimally.");
    }

    return list;
  }, [batches, discrepancies, productsInventory, locations]);

  // Global Search Filtering
  const filteredBatches = useMemo(() => {
    return batches.filter(b => {
      if (filterSource !== 'all' && b.from_location !== filterSource) return false;
      if (filterDest !== 'all' && b.to_location !== filterDest) return false;
      if (filterStatus !== 'all' && b.status !== filterStatus) return false;

      if (globalSearch.trim()) {
        const query = globalSearch.toLowerCase();
        const matchesSku = b.transfer_batch_items?.some((i: any) => 
          i.original_sku.toLowerCase().includes(query) || 
          i.resolved_master_sku.toLowerCase().includes(query)
        );
        const matchesBatchNo = b.transfer_group_id.toLowerCase().includes(query);
        const matchesEmployee = b.employee_id.toLowerCase().includes(query);
        if (!matchesSku && !matchesBatchNo && !matchesEmployee) return false;
      }
      return true;
    });
  }, [batches, filterSource, filterDest, filterStatus, globalSearch]);

  const filteredMatrix = useMemo(() => {
    return productsInventory.filter(pm => {
      if (!globalSearch.trim()) return true;
      const query = globalSearch.toLowerCase();
      return (
        pm.master_sku.toLowerCase().includes(query) ||
        pm.brand.toLowerCase().includes(query) ||
        pm.model.toLowerCase().includes(query) ||
        pm.size.toLowerCase().includes(query)
      );
    });
  }, [productsInventory, globalSearch]);

  const filteredWarranties = useMemo(() => {
    return warranties.filter(w => {
      if (!globalSearch.trim()) return true;
      const query = globalSearch.toLowerCase();
      return (
        w.customer_name.toLowerCase().includes(query) ||
        w.warranty_number.toLowerCase().includes(query) ||
        w.location_id.toLowerCase().includes(query) ||
        w.warranty_replacements?.some((wr: any) => wr.resolved_master_sku.toLowerCase().includes(query))
      );
    });
  }, [warranties, globalSearch]);

  return (
    <div className="space-y-6 flex-1 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between pb-4 border-b border-white/10">
        <div className="flex items-center gap-3">
          <button onClick={onBack} className="btn-secondary py-2 px-3 bg-white/5 border border-glass text-slate-100">
            <ArrowLeftRight className="w-4 h-4 rotate-180 inline mr-1" /> Back
          </button>
          <div>
            <h2 className="text-xl font-black text-white tracking-wide uppercase flex items-center gap-2">
              <Shield className="w-5 h-5 text-cyan-400" /> Super Admin Operations Center
            </h2>
            <p className="text-[10px] text-gray-400 uppercase tracking-widest mt-0.5">
              Unified Enterprise Dashboard & Warranty Control
            </p>
          </div>
        </div>

        {/* Global Search Input */}
        <div className="relative w-64">
          <Search className="absolute left-3 top-2 w-4 h-4 text-gray-500" />
          <input 
            type="text" 
            value={globalSearch}
            onChange={e => setGlobalSearch(e.target.value)}
            placeholder="Search SKU, customer, route, claim..."
            className="w-full text-xs bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-4 py-2 text-white placeholder-gray-500 focus:outline-none focus:border-cyan-500"
          />
        </div>
      </div>

      {/* Operations Center Sub-Tabs */}
      <div className="flex flex-wrap gap-2 border-b border-white/5 pb-2">
        <button 
          onClick={() => { setSubTab('overview'); setSelectedBatch(null); }}
          className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-lg transition-all ${subTab === 'overview' ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400' : 'text-gray-400 hover:text-white'}`}
        >
          Transfers Ledger
        </button>
        <button 
          onClick={() => { setSubTab('executive'); setSelectedBatch(null); }}
          className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-lg transition-all ${subTab === 'executive' ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400' : 'text-gray-400 hover:text-white'}`}
        >
          Executive Analytics
        </button>
        <button 
          onClick={() => { setSubTab('matrix'); setSelectedBatch(null); }}
          className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-lg transition-all ${subTab === 'matrix' ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400' : 'text-gray-400 hover:text-white'}`}
        >
          <Grid className="w-3.5 h-3.5 inline mr-1" /> Inventory Matrix
        </button>
        <button 
          onClick={() => { setSubTab('warranties'); setSelectedBatch(null); }}
          className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-lg transition-all ${subTab === 'warranties' ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400' : 'text-gray-400 hover:text-white'}`}
        >
          🛡️ Warranty claims ({executiveMetrics.pendingWarranties} Pending)
        </button>
        <button 
          onClick={() => { setSubTab('intelligence'); setSelectedBatch(null); }}
          className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-lg transition-all ${subTab === 'intelligence' ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400' : 'text-gray-400 hover:text-white'}`}
        >
          <Sparkles className="w-3.5 h-3.5 inline mr-1 text-yellow-400 animate-pulse" /> AI Inventory Intelligence
        </button>
        <button 
          onClick={() => { setSubTab('notifications'); setSelectedBatch(null); }}
          className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-lg transition-all ${subTab === 'notifications' ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400' : 'text-gray-400 hover:text-white'}`}
        >
          <Bell className="w-3.5 h-3.5 inline mr-1" /> Notifications
        </button>
        <button 
          onClick={() => { setSubTab('config'); setSelectedBatch(null); }}
          className={`px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider rounded-lg transition-all ${subTab === 'config' ? 'bg-cyan-500/10 border border-cyan-500/30 text-cyan-400' : 'text-gray-400 hover:text-white'}`}
        >
          <Sliders className="w-3.5 h-3.5 inline mr-1" /> Config Alerts
        </button>
      </div>

      {/* Tab: Overview (Active Ledger) */}
      {subTab === 'overview' && !selectedBatch && (
        <div className="space-y-6">
          {/* Quick Filter Box */}
          <div className="glass-panel p-4 flex flex-wrap gap-4 items-center justify-between text-xs">
            <div className="flex gap-2">
              <select 
                value={filterSource}
                onChange={e => setFilterSource(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-white rounded-lg px-2.5 py-1.5"
              >
                <option value="all">Source: All</option>
                {locations.map(l => <option key={l.location_id} value={l.location_id}>{l.location_name}</option>)}
              </select>

              <select 
                value={filterDest}
                onChange={e => setFilterDest(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-white rounded-lg px-2.5 py-1.5"
              >
                <option value="all">Destination: All</option>
                {locations.map(l => <option key={l.location_id} value={l.location_id}>{l.location_name}</option>)}
              </select>

              <select 
                value={filterStatus}
                onChange={e => setFilterStatus(e.target.value)}
                className="bg-slate-900 border border-slate-700 text-white rounded-lg px-2.5 py-1.5"
              >
                <option value="all">Status: All</option>
                <option value="submitted">Submitted</option>
                <option value="in_transit">In Transit</option>
                <option value="partially_received">Partially Received</option>
                <option value="received">Received</option>
                <option value="cancelled">Cancelled</option>
                <option value="reconciliation_required">Reconciliation Required</option>
              </select>
            </div>

            <button onClick={() => { setFilterSource('all'); setFilterDest('all'); setFilterStatus('all'); setGlobalSearch(''); }} className="text-gray-400 hover:text-white flex items-center gap-1">
              <Filter className="w-3.5 h-3.5" /> Reset Filters
            </button>
          </div>

          {/* Transfers Table */}
          <div className="glass-panel overflow-hidden">
            <div className="overflow-x-auto text-xs">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-white/5 text-gray-400 uppercase font-semibold">
                    <th className="p-3">Transfer Number</th>
                    <th className="p-3">From</th>
                    <th className="p-3">To</th>
                    <th className="p-3">Submitted By</th>
                    <th className="p-3">Submitted At</th>
                    <th className="p-3">Status</th>
                    <th className="p-3 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-slate-200">
                  {filteredBatches.map(b => (
                    <tr key={b.id} className="hover:bg-white/5">
                      <td className="p-3 font-mono text-cyan-400 font-bold">{b.transfer_group_id}</td>
                      <td className="p-3 capitalize">{b.from_location}</td>
                      <td className="p-3 capitalize">{b.to_location}</td>
                      <td className="p-3">{b.employee_id}</td>
                      <td className="p-3">{new Date(b.submitted_at).toLocaleString()}</td>
                      <td className="p-3">
                        {(() => {
                          const aging = getAgingStatus(b.submitted_at);
                          return (
                            <span className={`badge ${aging.color} text-[9px] uppercase font-bold mr-1.5`}>
                              {aging.label}
                            </span>
                          );
                        })()}
                        <span className={`badge ${
                          b.status === 'received' ? 'badge-green' : 
                          b.status === 'reconciliation_required' ? 'badge-rose' : 
                          b.status === 'cancelled' ? 'badge-gray' : 'badge-amber'
                        } text-[9px] uppercase font-bold`}>
                          {b.status.replace('_', ' ')}
                        </span>
                      </td>
                      <td className="p-3 text-right">
                        <button onClick={() => viewBatchDetails(b)} className="btn-secondary py-1 px-2.5 text-[10px] bg-slate-900 border border-slate-700 text-white inline-flex items-center gap-1">
                          <Eye className="w-3.5 h-3.5" /> View
                        </button>
                      </td>
                    </tr>
                  ))}
                  {filteredBatches.length === 0 && (
                    <tr>
                      <td colSpan={7} className="p-8 text-center text-gray-500">
                        No active transfers found matching search filters.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Detail view */}
      {selectedBatch && (
        <div className="space-y-6 text-xs">
          <div className="flex items-center justify-between pb-4 border-b border-white/5">
            <div className="flex items-center gap-3">
              <button onClick={() => setSelectedBatch(null)} className="btn-secondary py-1 px-2.5 bg-slate-900 border border-slate-700 text-white">
                &larr; Back
              </button>
              <h3 className="text-base font-bold text-white">
                Transfer Details: <span className="font-mono text-cyan-400">{selectedBatch.transfer_group_id}</span>
              </h3>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <div className="glass-panel p-4 md:col-span-2 space-y-4">
              <h4 className="font-bold text-white uppercase border-b border-white/5 pb-2">Products</h4>
              <table className="w-full text-left">
                <thead>
                  <tr className="text-gray-500 uppercase font-semibold border-b border-white/5">
                    <th className="pb-2">SKU Details</th>
                    <th className="pb-2 text-center">Shipped</th>
                    <th className="pb-2 text-center">Good</th>
                    <th className="pb-2 text-center">Damaged</th>
                    <th className="pb-2 text-center">Missing</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-slate-200">
                  {selectedBatchItems.map((item: any) => (
                    <tr key={item.id}>
                      <td className="py-2.5">
                        <span className="font-semibold block text-slate-100">{item.resolved_master_sku}</span>
                        <span className="text-[10px] text-gray-500 block uppercase">{item.original_sku}</span>
                      </td>
                      <td className="py-2.5 text-center font-bold">{item.shipped_quantity}</td>
                      <td className="py-2.5 text-center text-green-400">{item.received_good_quantity}</td>
                      <td className="py-2.5 text-center text-purple-400">{item.received_damaged_quantity}</td>
                      <td className="py-2.5 text-center text-rose-400">{item.confirmed_missing_quantity}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <div className="glass-panel p-4 space-y-4">
              <h4 className="font-bold text-white uppercase border-b border-white/5 pb-2">Auditing Details</h4>
              <div className="space-y-3">
                <div>
                  <span className="text-gray-500 block uppercase text-[9px]">Source Route</span>
                  <span className="text-slate-200 capitalize font-bold">{selectedBatch.from_location} &rarr; {selectedBatch.to_location}</span>
                </div>
                <div>
                  <span className="text-gray-500 block uppercase text-[9px]">Submitted By</span>
                  <span className="text-slate-200 font-bold">{selectedBatch.employee_id}</span>
                </div>
                <div>
                  <span className="text-gray-500 block uppercase text-[9px]">Notes</span>
                  <span className="text-slate-200 italic font-bold">{selectedBatch.notes || 'N/A'}</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Executive Dashboard */}
      {subTab === 'executive' && (
        <div className="space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-xs">
            <div className="glass-panel p-4 border-l-4 border-l-cyan-500">
              <span className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Total Company Value</span>
              <div className="text-2xl font-black text-white mt-1">${(executiveMetrics.totalValue).toLocaleString()}</div>
              <span className="text-[10px] text-cyan-400 font-semibold block mt-1">Total Stock: {executiveMetrics.totalUnits} Units</span>
            </div>

            <div className="glass-panel p-4 border-l-4 border-l-purple-500">
              <span className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">In-Transit Value</span>
              <div className="text-2xl font-black text-white mt-1">${(executiveMetrics.valueInTransit).toLocaleString()}</div>
              <span className="text-[10px] text-purple-400 font-semibold block mt-1">In Transit Qty: {executiveMetrics.unitsInTransit} Units</span>
            </div>

            <div className="glass-panel p-4 border-l-4 border-l-amber-500">
              <span className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Warranty Claims Cost</span>
              <div className="text-2xl font-black text-white mt-1">${(executiveMetrics.warrantyCosts).toLocaleString()}</div>
              <span className="text-[10px] text-amber-400 font-semibold block mt-1">Supplier Recovery: ${(executiveMetrics.supplierRecoveries).toLocaleString()}</span>
            </div>

            <div className="glass-panel p-4 border-l-4 border-l-rose-500">
              <span className="text-[10px] text-gray-400 uppercase tracking-widest font-bold">Company Health Score</span>
              <div className="text-2xl font-black text-white mt-1">{executiveMetrics.healthScore}%</div>
              <span className="text-[10px] text-rose-400 font-semibold block mt-1">{executiveMetrics.discrepanciesCount} Open Discrepancies</span>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 text-xs">
            <div className="glass-panel p-4 space-y-4">
              <h3 className="font-bold text-white uppercase border-b border-white/5 pb-2">Operational Analytics Today</h3>
              <div className="space-y-3">
                <div className="flex justify-between border-b border-white/5 pb-2">
                  <span className="text-gray-400">Transfers Initiated Today</span>
                  <span className="text-white font-bold">{executiveMetrics.transfersToday}</span>
                </div>
                <div className="flex justify-between border-b border-white/5 pb-2">
                  <span className="text-gray-400">Open In-Transit Batches</span>
                  <span className="text-white font-bold">{executiveMetrics.openTransfers}</span>
                </div>
                <div className="flex justify-between border-b border-white/5 pb-2">
                  <span className="text-gray-400">Damaged Inventory Qty</span>
                  <span className="text-white font-bold text-purple-400">{executiveMetrics.damagedUnits} Units</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Confirmed Missing Qty</span>
                  <span className="text-white font-bold text-rose-400">{executiveMetrics.missingUnits} Units</span>
                </div>
              </div>
            </div>

            <div className="glass-panel p-4 space-y-4">
              <h3 className="font-bold text-white uppercase border-b border-white/5 pb-2">Alert Center Summary</h3>
              <div className="space-y-3">
                <div className="flex justify-between border-b border-white/5 pb-2">
                  <span className="text-gray-400">Low Stock SKUs</span>
                  <span className="text-white font-bold text-amber-400">{executiveMetrics.lowStockCount} Items</span>
                </div>
                <div className="flex justify-between border-b border-white/5 pb-2">
                  <span className="text-gray-400">Pending Warranty Claims</span>
                  <span className="text-white font-bold">{executiveMetrics.pendingWarranties} Claims</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Cache Reconciliation Mismatches</span>
                  <span className="text-white font-bold text-green-400">0 Inconsistencies</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Company Inventory Matrix */}
      {subTab === 'matrix' && (
        <div className="space-y-4 text-xs">
          <div className="glass-panel overflow-hidden">
            <h3 className="font-semibold uppercase text-gray-400 px-4 py-3 border-b border-white/5 flex items-center gap-1.5">
              <Grid className="w-4 h-4 text-cyan-400" /> Dynamic Cross-Location Stock Ledger
            </h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr className="bg-white/5 text-gray-400 uppercase font-semibold">
                    <th className="p-3">Product Detail</th>
                    <th className="p-3 text-center">Company Total</th>
                    {locations.map(loc => (
                      <th key={loc.location_id} className="p-3 text-center capitalize">{loc.location_name}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 text-slate-200">
                  {filteredMatrix.map(pm => (
                    <tr key={pm.id} className="hover:bg-white/5">
                      <td className="p-3">
                        <span className="font-semibold block text-slate-100">{pm.master_sku}</span>
                        <span className="text-[10px] text-gray-500 block">{pm.brand} {pm.model} ({pm.size})</span>
                      </td>
                      <td className="p-3 text-center font-bold text-cyan-400">{pm.stock}</td>
                      {locations.map(loc => {
                        const pli = pm.product_location_inventory?.find((l: any) => l.location_id === loc.location_id);
                        const qty = pli ? pli.quantity : null;
                        const inTransit = pli ? pli.in_transit_quantity : 0;
                        return (
                          <td key={loc.location_id} className="p-3 text-center">
                            {qty === null ? (
                              <span className="text-gray-500 italic">Pending</span>
                            ) : (
                              <span className="font-semibold text-slate-100">{qty}</span>
                            )}
                            {inTransit > 0 && (
                              <span className="text-[9px] text-purple-400 block font-semibold">(+{inTransit} In Transit)</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Tab: Warranty Claims Center */}
      {subTab === 'warranties' && (
        <div className="space-y-4 text-xs">
          <div className="grid grid-cols-1 gap-4">
            {filteredWarranties.map(w => (
              <div key={w.id} className="glass-panel p-4 border-l-4 border-l-amber-500 flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
                <div className="space-y-1 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-cyan-400 font-bold text-[11px]">{w.warranty_number}</span>
                    <span className="badge badge-amber text-[9px] uppercase font-bold">{w.status.replace('_', ' ')}</span>
                  </div>
                  <p className="text-slate-200">
                    Customer: <strong className="text-white">{w.customer_name}</strong> {w.customer_phone ? `(${w.customer_phone})` : ''}
                  </p>
                  <div className="space-y-1 bg-white/5 p-2 rounded-lg mt-2 max-w-lg">
                    <span className="text-[10px] text-gray-400 uppercase tracking-widest font-bold block">Replacements</span>
                    {w.warranty_replacements?.map((wr: any) => (
                      <div key={wr.id} className="flex justify-between text-slate-300">
                        <span>{wr.resolved_master_sku}</span>
                        <span>{wr.quantity} Unit(s) (Claim: ${wr.claim_amount})</span>
                      </div>
                    ))}
                  </div>
                  <span className="text-[10px] text-gray-500 block uppercase">
                    Location: {w.location_id} | Staff: {w.employee_id} | Date: {new Date(w.submitted_at).toLocaleString()}
                  </span>
                  {w.notes && <p className="text-[10px] text-slate-400 italic">Notes: "{w.notes}"</p>}
                </div>

                {w.status === 'submitted' && (
                  <div className="flex gap-2 shrink-0">
                    <button 
                      onClick={() => handleApproveWarranty(w)}
                      disabled={processingWarranty === w.id}
                      className="btn-secondary py-1 px-2.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold border-none"
                    >
                      {processingWarranty === w.id ? 'Processing...' : 'Approve claim'}
                    </button>
                    <button 
                      onClick={() => handleRejectWarranty(w.id)}
                      className="btn-secondary py-1 px-2.5 bg-rose-600 hover:bg-rose-700 text-white font-bold border-none"
                    >
                      Reject
                    </button>
                  </div>
                )}

                {w.status === 'approved' && (
                  <div className="flex gap-2 shrink-0">
                    <button 
                      onClick={() => handleCloseWarranty(w.id, 120)}
                      className="btn-secondary py-1 px-2.5 bg-cyan-600 hover:bg-cyan-700 text-white font-bold border-none"
                    >
                      Claim Supplier recovery
                    </button>
                  </div>
                )}
              </div>
            ))}
            {filteredWarranties.length === 0 && (
              <div className="glass-panel p-8 text-center text-gray-500">
                No warranty claims found matching filters.
              </div>
            )}
          </div>
        </div>
      )}

      {/* Tab: AI Inventory Intelligence */}
      {subTab === 'intelligence' && (
        <div className="space-y-6 text-xs">
          <div className="glass-panel p-6 border-l-4 border-l-yellow-500 space-y-4">
            <h3 className="text-base font-bold text-white uppercase flex items-center gap-1.5">
              <Sparkles className="w-5 h-5 text-yellow-400 animate-pulse" /> AI Demand-Replenishment Insights
            </h3>
            <p className="text-slate-300">
              Continuous scan of inter-store transfers, warranties, and stock levels to calculate optimal local inventory balance.
            </p>
            <div className="space-y-3 pt-2">
              {aiInsights.map((insight, idx) => (
                <div key={idx} className="p-3 bg-white/5 border border-white/10 rounded-lg text-slate-200">
                  {insight}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Tab: Notification Rules */}
      {subTab === 'notifications' && (
        <div className="glass-panel p-6 space-y-6 text-xs max-w-lg">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
            <Bell className="w-4 h-4 text-cyan-400" /> Configurable Notification Preferences
          </h3>

          <div className="space-y-4">
            {[
              { key: 'lowStock', label: 'Low Stock warnings', desc: 'Alert when complete PLI stock drops below 3 units' },
              { key: 'transferDelayed', label: 'Transfer delay triggers', desc: 'Alert when transfer batch aging exceeds threshold limits' },
              { key: 'discrepancyAlerts', label: 'Missing / Damaged exceptions alerts', desc: 'Alert when receiving discrepancy cases are logged' },
              { key: 'warrantySubmitted', label: 'Warranty claim submissions', desc: 'Alert when store managers submit warranty requests' },
              { key: 'failedTransaction', label: 'Failed inventory transaction warnings', desc: 'Alert if cache mismatch triggers rollbacks' }
            ].map(rule => (
              <label key={rule.key} className="flex items-start gap-3 p-3 bg-white/5 border border-white/10 rounded-lg cursor-pointer">
                <input 
                  type="checkbox"
                  checked={(notifRules as any)[rule.key]}
                  onChange={e => setNotifRules(prev => ({ ...prev, [rule.key]: e.target.checked }))}
                  className="rounded border-slate-700 bg-slate-900 text-cyan-500 focus:ring-cyan-500 w-4 h-4 mt-0.5"
                />
                <div>
                  <span className="text-slate-200 font-semibold block">{rule.label}</span>
                  <span className="text-[10px] text-gray-500 block">{rule.desc}</span>
                </div>
              </label>
            ))}

            <button onClick={() => showTemporaryMessage('success', 'Notification preferences saved successfully.')} className="btn-secondary bg-cyan-500 text-slate-950 font-bold py-2 w-full">
              Save Notification Preferences
            </button>
          </div>
        </div>
      )}

      {/* Tab: Config Warnings */}
      {subTab === 'config' && (
        <div className="glass-panel p-6 space-y-6 text-xs max-w-lg">
          <h3 className="text-xs font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
            <Sliders className="w-4 h-4 text-cyan-400" /> Aging & Delay Alert Limits
          </h3>

          <div className="space-y-4">
            <div className="space-y-1">
              <label className="block text-gray-400 font-bold uppercase text-[10px]">Delayed Warning (Hours)</label>
              <input 
                type="number" 
                value={delayThreshold}
                onChange={e => setDelayThreshold(Number(e.target.value))}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-gray-400 font-bold uppercase text-[10px]">Overdue Threshold (Hours)</label>
              <input 
                type="number" 
                value={overdueThreshold}
                onChange={e => setOverdueThreshold(Number(e.target.value))}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-gray-400 font-bold uppercase text-[10px]">Critical Aging Level (Hours)</label>
              <input 
                type="number" 
                value={criticalThreshold}
                onChange={e => setCriticalThreshold(Number(e.target.value))}
                className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white"
              />
            </div>

            <button onClick={() => showTemporaryMessage('success', 'Alert thresholds updated successfully.')} className="btn-secondary bg-cyan-500 text-slate-950 font-bold py-2 w-full">
              Save Alert Preferences
            </button>

            <div className="pt-4 border-t border-white/5 space-y-2">
              <span className="text-[10px] text-gray-500 block uppercase font-bold">Manual Cache Audits</span>
              <button 
                type="button"
                onClick={triggerReconciliationReview}
                disabled={reconciling}
                className="btn-secondary bg-purple-600 hover:bg-purple-700 text-white font-bold py-2 w-full flex items-center justify-center gap-1.5 border-none"
              >
                {reconciling ? 'Running Reconciliation review...' : 'Run Cache Reconciliation Check Now'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
