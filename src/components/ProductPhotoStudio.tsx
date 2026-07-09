import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Camera, CheckCircle, ImageIcon, RotateCw, Trash2 } from 'lucide-react';
import { supabase } from '../supabaseClient';
import { isCatalogImageMissing } from '../lib/storeLocations';
import {
  processProductStudioPhoto,
  readFileAsDataUrl,
} from '../lib/imageStudio';

export type MissingProduct = {
  sku: string;
  brand: string;
  size: string;
  name: string;
  productType: 'tire' | 'wheel';
  createdAt?: string;
};

type ProductPhotoStudioProps = {
  activeLocation: string;
  employeeName: string;
  gpsCoords: { lat: number; lng: number } | null;
  onBack: () => void;
  onCountChange: (count: number) => void;
  showMessage: (type: 'success' | 'error', text: string) => void;
};

export function ProductPhotoStudio({
  activeLocation,
  employeeName,
  gpsCoords,
  onBack,
  onCountChange,
  showMessage,
}: ProductPhotoStudioProps) {
  const [loading, setLoading] = useState(true);
  const [queue, setQueue] = useState<MissingProduct[]>([]);
  const [selected, setSelected] = useState<MissingProduct | null>(null);
  const [rawPhoto, setRawPhoto] = useState<string | null>(null);
  const [processedPhoto, setProcessedPhoto] = useState<string | null>(null);
  const [processing, setProcessing] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadQueue = useCallback(async () => {
    setLoading(true);
    try {
      const [tiresRes, wheelsRes] = await Promise.all([
        supabase
          .from('tires_catalog')
          .select('sku, brand, size, name, image, created_at')
          .neq('sku', 'CONFIG-EMPLOYEES')
          .order('created_at', { ascending: false })
          .limit(200),
        supabase
          .from('wheels_catalog')
          .select('sku, brand, size, name, image, created_at')
          .order('created_at', { ascending: false })
          .limit(200),
      ]);

      const missing: MissingProduct[] = [];
      for (const row of tiresRes.data || []) {
        if (isCatalogImageMissing(row.image)) {
          missing.push({
            sku: row.sku,
            brand: row.brand,
            size: row.size,
            name: row.name,
            productType: 'tire',
            createdAt: row.created_at,
          });
        }
      }
      for (const row of wheelsRes.data || []) {
        if (isCatalogImageMissing(row.image)) {
          missing.push({
            sku: row.sku,
            brand: row.brand,
            size: row.size,
            name: row.name,
            productType: 'wheel',
            createdAt: row.created_at,
          });
        }
      }

      missing.sort((a, b) => {
        const ta = a.createdAt ? Date.parse(a.createdAt) : 0;
        const tb = b.createdAt ? Date.parse(b.createdAt) : 0;
        return tb - ta;
      });

      setQueue(missing);
      onCountChange(missing.length);
    } catch (e: any) {
      showMessage('error', `Could not load photo queue: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }, [onCountChange, showMessage]);

  useEffect(() => {
    loadQueue();
  }, [loadQueue]);

  const resetSelection = () => {
    setSelected(null);
    setRawPhoto(null);
    setProcessedPhoto(null);
  };

  const handleProcess = async () => {
    if (!rawPhoto) return;
    setProcessing(true);
    try {
      const studio = await processProductStudioPhoto(rawPhoto);
      setProcessedPhoto(studio);
      showMessage('success', 'AI studio preview ready — white background applied.');
    } catch (e: any) {
      showMessage('error', e.message || 'Photo processing failed');
    } finally {
      setProcessing(false);
    }
  };

  const handleSave = async () => {
    if (!selected || !processedPhoto) return;
    if (!gpsCoords) {
      showMessage('error', 'GPS required — must be on premises to upload catalog photos.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/upload-product-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sku: selected.sku,
          productType: selected.productType,
          imageData: processedPhoto,
          lat: gpsCoords.lat,
          lng: gpsCoords.lng,
          employeeId: employeeName,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Upload failed');

      showMessage('success', `Catalog photo saved for ${selected.brand} ${selected.size}!`);
      resetSelection();
      await loadQueue();
    } catch (e: any) {
      showMessage('error', e.message || 'Could not save product photo');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-6 flex-1 flex flex-col">
      <div className="flex items-center gap-2 mb-2">
        <button type="button" onClick={onBack} className="btn-secondary py-2 px-3">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2>Product Photo Studio</h2>
        <span className="badge badge-amber text-xs ml-auto">{queue.length} missing</span>
      </div>

      <div className="glass-panel">
        <p className="text-sm text-gray-500">
          Products received without photos appear here. Shoot one tire/wheel on white, run AI studio, and publish to
          catalog + website. Location: <strong>{activeLocation}</strong>
        </p>
      </div>

      {!selected ? (
        <div className="space-y-3 flex-1">
          {loading ? (
            <div className="glass-panel py-12 text-center text-gray-500">
              <RotateCw className="w-6 h-6 animate-spin mx-auto mb-2" /> Loading queue…
            </div>
          ) : queue.length === 0 ? (
            <div className="glass-panel py-12 text-center text-gray-500">
              <CheckCircle className="w-8 h-8 text-emerald-500 mx-auto mb-2" />
              All catalog products have photos. Nice work!
            </div>
          ) : (
            queue.map((item) => (
              <button
                key={`${item.productType}-${item.sku}`}
                type="button"
                onClick={() => setSelected(item)}
                className="w-full glass-panel glass-panel-interactive flex items-center justify-between p-4 text-left"
              >
                <div>
                  <span className="badge badge-amber text-xs">{item.productType}</span>
                  <div className="font-semibold text-slate-800 mt-1">{item.brand} {item.name}</div>
                  <div className="text-xs text-gray-500">{item.size} · {item.sku}</div>
                </div>
                <ImageIcon className="w-5 h-5 text-primary" />
              </button>
            ))
          )}
        </div>
      ) : (
        <div className="glass-panel space-y-5">
          <div className="flex justify-between items-start">
            <div>
              <h3 className="font-bold text-slate-800">{selected.brand} {selected.name}</h3>
              <p className="text-xs text-gray-500">{selected.size} · {selected.sku}</p>
            </div>
            <button type="button" className="btn-secondary py-1.5 px-2 text-xs" onClick={resetSelection}>
              ← Queue
            </button>
          </div>

          {!rawPhoto ? (
            <label className="btn-secondary py-4 flex items-center justify-center gap-2 cursor-pointer w-full">
              <Camera className="w-5 h-5 text-primary" />
              Take Product Photo
              <input
                type="file"
                accept="image/*"
                capture="environment"
                className="hidden"
                onChange={async (e) => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const dataUrl = await readFileAsDataUrl(file);
                  setRawPhoto(dataUrl);
                  setProcessedPhoto(null);
                }}
              />
            </label>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <p className="text-xs font-semibold text-gray-500 mb-2">RAW</p>
                <img src={rawPhoto} alt="Raw" className="rounded-xl border border-glass max-h-48 w-full object-contain bg-white" />
              </div>
              {processedPhoto && (
                <div>
                  <p className="text-xs font-semibold text-gray-500 mb-2">STUDIO PREVIEW</p>
                  <img src={processedPhoto} alt="Studio" className="rounded-xl border border-glass max-h-48 w-full object-contain bg-white" />
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap gap-3">
            {rawPhoto && !processedPhoto && (
              <button type="button" className="btn-primary py-3 px-4 flex-1" onClick={handleProcess} disabled={processing}>
                {processing ? <RotateCw className="w-4 h-4 animate-spin" /> : <SparklesIcon />}
                {processing ? 'AI Studio…' : 'Run AI Studio'}
              </button>
            )}
            {rawPhoto && (
              <button type="button" className="btn-secondary py-3 px-4" onClick={() => { setRawPhoto(null); setProcessedPhoto(null); }}>
                <Trash2 className="w-4 h-4" /> Retake
              </button>
            )}
            {processedPhoto && (
              <button type="button" className="btn-primary py-3 px-4 flex-1" onClick={handleSave} disabled={saving}>
                {saving ? <RotateCw className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
                Save to Catalog
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SparklesIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
    </svg>
  );
}
