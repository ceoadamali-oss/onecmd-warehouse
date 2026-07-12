import React, { useState } from 'react';
import { supabase } from '../supabaseClient';
import { Shield, ArrowLeft, Search } from 'lucide-react';

interface SubmitWarrantyFormProps {
  currentUser: any;
  activeLocation: string;
  onBack: () => void;
  showTemporaryMessage: (type: 'success' | 'error', text: string) => void;
}

export const SubmitWarrantyForm: React.FC<SubmitWarrantyFormProps> = ({
  currentUser,
  activeLocation,
  onBack,
  showTemporaryMessage
}) => {
  const [customerName, setCustomerName] = useState('');
  const [customerPhone, setCustomerPhone] = useState('');
  const [skuSearch, setSkuSearch] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<any | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [claimAmount, setClaimAmount] = useState(120);
  const [notes, setNotes] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Search product catalog
  const handleSkuSearch = async () => {
    if (!skuSearch.trim()) return;
    try {
      const { data, error } = await supabase
        .from('product_master')
        .select('*')
        .or(`master_sku.ilike.%${skuSearch}%,brand.ilike.%${skuSearch}%,model.ilike.%${skuSearch}%`)
        .limit(5);

      if (error) throw error;
      setSearchResults(data || []);
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to search products: ${e.message}`);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProduct) {
      showTemporaryMessage('error', 'Please select a replacement product.');
      return;
    }
    if (quantity <= 0) {
      showTemporaryMessage('error', 'Quantity must be at least 1.');
      return;
    }

    setSubmitting(true);
    try {
      const warrantyNum = `WR-${Date.now()}`;
      
      // 1. Insert warranty request header
      const { data: warranty, error: wErr } = await supabase
        .from('warranties')
        .insert({
          warranty_number: warrantyNum,
          location_id: activeLocation,
          customer_name: customerName,
          customer_phone: customerPhone || null,
          employee_id: currentUser?.name || 'Staff',
          notes: notes || '',
          status: 'submitted'
        })
        .select('id')
        .single();

      if (wErr) throw wErr;

      // 2. Insert warranty request item details
      const { error: itemErr } = await supabase
        .from('warranty_replacements')
        .insert({
          warranty_id: warranty.id,
          product_id: selectedProduct.id,
          original_sku: selectedProduct.master_sku,
          resolved_master_sku: selectedProduct.master_sku,
          quantity: quantity,
          claim_amount: claimAmount,
          supplier_claim_status: 'pending'
        });

      if (itemErr) throw itemErr;

      showTemporaryMessage('success', `Warranty request ${warrantyNum} submitted successfully!`);
      onBack();
    } catch (e: any) {
      showTemporaryMessage('error', `Failed to submit request: ${e.message}`);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="space-y-6 flex-1 flex flex-col max-w-xl mx-auto text-xs">
      <div className="flex items-center gap-3 pb-4 border-b border-white/10">
        <button onClick={onBack} className="btn-secondary py-2 px-3 bg-white/5 border border-glass text-slate-100">
          <ArrowLeft className="w-4 h-4 inline mr-1" /> Back
        </button>
        <div>
          <h2 className="text-base font-bold text-white uppercase tracking-wider flex items-center gap-1.5">
            <Shield className="w-4 h-4 text-amber-500" /> Submit Warranty Request
          </h2>
          <p className="text-[10px] text-gray-400 uppercase tracking-widest mt-0.5">
            Register claim details for admin verification and stock deduction
          </p>
        </div>
      </div>

      <form onSubmit={handleSubmit} className="glass-panel p-6 space-y-4">
        {/* Customer Info */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="block text-gray-400 font-bold uppercase">Customer Name</label>
            <input 
              type="text" 
              value={customerName}
              onChange={e => setCustomerName(e.target.value)}
              required
              className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white"
              placeholder="e.g. John Doe"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-gray-400 font-bold uppercase">Customer Phone</label>
            <input 
              type="text" 
              value={customerPhone}
              onChange={e => setCustomerPhone(e.target.value)}
              className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white"
              placeholder="e.g. 506-555-0199"
            />
          </div>
        </div>

        {/* Product SKU Catalog Lookup */}
        <div className="space-y-2">
          <label className="block text-gray-400 font-bold uppercase">Search Replacement Product</label>
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-3 top-2 w-4 h-4 text-gray-500" />
              <input 
                type="text" 
                value={skuSearch}
                onChange={e => setSkuSearch(e.target.value)}
                placeholder="Search Master SKU, brand, model..."
                className="w-full bg-slate-900 border border-slate-700 rounded-lg pl-9 pr-4 py-2 text-white placeholder-gray-500"
              />
            </div>
            <button 
              type="button" 
              onClick={handleSkuSearch}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 border border-slate-600 rounded-lg font-bold text-white"
            >
              Search
            </button>
          </div>

          {/* Search Results */}
          {searchResults.length > 0 && (
            <div className="bg-slate-900 border border-slate-700 rounded-lg divide-y divide-white/5 overflow-hidden">
              {searchResults.map(p => (
                <button
                  type="button"
                  key={p.id}
                  onClick={() => { setSelectedProduct(p); setSearchResults([]); }}
                  className="w-full text-left p-2.5 hover:bg-white/5 flex justify-between items-center"
                >
                  <div>
                    <span className="font-semibold block text-slate-100">{p.master_sku}</span>
                    <span className="text-[10px] text-gray-400 block">{p.brand} {p.model} ({p.size})</span>
                  </div>
                  <span className="text-[10px] text-cyan-400 font-bold">Select</span>
                </button>
              ))}
            </div>
          )}

          {/* Selected Product */}
          {selectedProduct && (
            <div className="p-3 bg-cyan-500/5 border border-cyan-500/20 rounded-lg flex items-center justify-between">
              <div>
                <span className="text-gray-400 block uppercase font-bold text-[9px]">Selected Replacement</span>
                <span className="text-white font-bold block">{selectedProduct.master_sku}</span>
                <span className="text-[10px] text-gray-300 block">{selectedProduct.brand} {selectedProduct.model}</span>
              </div>
              <button 
                type="button" 
                onClick={() => setSelectedProduct(null)}
                className="text-rose-400 hover:text-rose-300 font-bold"
              >
                Clear
              </button>
            </div>
          )}
        </div>

        {/* Quantities & Claim Amounts */}
        <div className="grid grid-cols-2 gap-4">
          <div className="space-y-1">
            <label className="block text-gray-400 font-bold uppercase">Replacement Qty</label>
            <input 
              type="number" 
              value={quantity}
              onChange={e => setQuantity(Number(e.target.value))}
              min={1}
              required
              className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white"
            />
          </div>
          <div className="space-y-1">
            <label className="block text-gray-400 font-bold uppercase">Claim Cost Amount ($)</label>
            <input 
              type="number" 
              value={claimAmount}
              onChange={e => setClaimAmount(Number(e.target.value))}
              min={0}
              required
              className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white"
            />
          </div>
        </div>

        {/* Notes */}
        <div className="space-y-1">
          <label className="block text-gray-400 font-bold uppercase">Claim Reason & Details</label>
          <textarea 
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={3}
            required
            placeholder="Describe tread separation, side bubble, or manufacturing defect..."
            className="w-full bg-slate-900 border border-slate-700 rounded-lg p-2 text-white resize-none"
          />
        </div>

        {/* Submit */}
        <button 
          type="submit" 
          disabled={submitting}
          className="btn-secondary bg-amber-500 text-slate-950 font-bold py-2.5 w-full flex items-center justify-center gap-1.5"
        >
          <Shield className="w-4 h-4" />
          {submitting ? 'Submitting request...' : 'Submit Warranty Claim'}
        </button>
      </form>
    </div>
  );
};
