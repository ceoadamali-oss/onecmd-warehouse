import { useState, type ReactNode } from 'react';
import { ArrowLeft, Camera, CheckCircle, Plus, RotateCw, Trash2, Truck } from 'lucide-react';
import { STORE_LOCATIONS } from '../lib/storeLocations';
import { enhanceBuildPhoto, readFileAsDataUrl } from '../lib/imageStudio';
import { authHeaders } from '../staffAuth';

type BuildGalleryStudioProps = {
  activeLocation: string;
  employeeName: string;
  gpsCoords: { lat: number; lng: number } | null;
  isSuperAdmin: boolean;
  onBack: () => void;
  showMessage: (type: 'success' | 'error', text: string) => void;
};

export function BuildGalleryStudio({
  activeLocation,
  employeeName,
  gpsCoords,
  isSuperAdmin,
  onBack,
  showMessage,
}: BuildGalleryStudioProps) {
  const [heroPhoto, setHeroPhoto] = useState<string | null>(null);
  const [enhancedPhoto, setEnhancedPhoto] = useState<string | null>(null);
  const [extraPhotos, setExtraPhotos] = useState<string[]>([]);
  const [processing, setProcessing] = useState(false);
  const [publishing, setPublishing] = useState(false);

  const [form, setForm] = useState({
    storeId: activeLocation,
    vehicleYear: '',
    vehicleMake: '',
    vehicleModel: '',
    vehicleTrim: '',
    wheelLabel: '',
    tireSize: '',
    liftKitBrand: '',
    liftHeight: '',
    caption: '',
  });

  const handleEnhance = async () => {
    if (!heroPhoto) return;
    setProcessing(true);
    try {
      const enhanced = await enhanceBuildPhoto(heroPhoto);
      setEnhancedPhoto(enhanced);
      showMessage('success', 'Build photo enhanced — ready to publish to website gallery.');
    } catch (e: any) {
      showMessage('error', e.message || 'Enhancement failed');
    } finally {
      setProcessing(false);
    }
  };

  const handlePublish = async () => {
    if (!enhancedPhoto) {
      showMessage('error', 'Enhance the hero photo first.');
      return;
    }
    if (!form.vehicleMake.trim() || !form.wheelLabel.trim()) {
      showMessage('error', 'Vehicle make and wheel/tire details are required.');
      return;
    }
    if (!gpsCoords && !isSuperAdmin) {
      showMessage('error', 'Location verification is required to publish gallery builds.');
      return;
    }

    setPublishing(true);
    try {
      const res = await fetch('/api/upload-gallery-build', {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          imageData: enhancedPhoto,
          extraImages: extraPhotos,
          storeId: form.storeId,
          vehicleYear: form.vehicleYear,
          vehicleMake: form.vehicleMake,
          vehicleModel: form.vehicleModel,
          vehicleTrim: form.vehicleTrim,
          wheelLabel: form.wheelLabel,
          tireSize: form.tireSize,
          liftKitBrand: form.liftKitBrand,
          liftHeight: form.liftHeight,
          caption: form.caption,
          addedBy: employeeName,
          lat: gpsCoords?.lat,
          lng: gpsCoords?.lng,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Publish failed');

      showMessage('success', 'Build published to Atlantic Tire King website gallery!');
      setHeroPhoto(null);
      setEnhancedPhoto(null);
      setExtraPhotos([]);
      setForm({
        storeId: activeLocation,
        vehicleYear: '',
        vehicleMake: '',
        vehicleModel: '',
        vehicleTrim: '',
        wheelLabel: '',
        tireSize: '',
        liftKitBrand: '',
        liftHeight: '',
        caption: '',
      });
    } catch (e: any) {
      showMessage('error', e.message || 'Could not publish build');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="space-y-6 flex-1 flex flex-col">
      <div className="flex items-center gap-2 mb-2">
        <button type="button" onClick={onBack} className="btn-secondary py-2 px-3">
          <ArrowLeft className="w-4 h-4" /> Back
        </button>
        <h2>Build Gallery Studio</h2>
        <Truck className="w-5 h-5 text-violet-500 ml-auto" />
      </div>

      <div className="glass-panel">
        <p className="text-sm text-gray-500">
          Photograph completed customer builds (wheels, tires, lift kits). Enhanced photos publish directly to the
          website gallery on Supabase.
        </p>
      </div>

      <div className="glass-panel space-y-4">
        <h3 className="text-xs font-semibold tracking-wider text-gray-400 uppercase">Vehicle & Build Details</h3>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Store">
            <select
              value={form.storeId}
              onChange={(e) => setForm({ ...form, storeId: e.target.value })}
              className="w-full"
            >
              {STORE_LOCATIONS.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </Field>
          <Field label="Year">
            <input value={form.vehicleYear} onChange={(e) => setForm({ ...form, vehicleYear: e.target.value })} placeholder="2024" className="w-full" />
          </Field>
          <Field label="Make *">
            <input value={form.vehicleMake} onChange={(e) => setForm({ ...form, vehicleMake: e.target.value })} placeholder="RAM" className="w-full" />
          </Field>
          <Field label="Model">
            <input value={form.vehicleModel} onChange={(e) => setForm({ ...form, vehicleModel: e.target.value })} placeholder="1500" className="w-full" />
          </Field>
          <Field label="Trim">
            <input value={form.vehicleTrim} onChange={(e) => setForm({ ...form, vehicleTrim: e.target.value })} placeholder="Sport" className="w-full" />
          </Field>
          <Field label="Wheels / Rims *">
            <input value={form.wheelLabel} onChange={(e) => setForm({ ...form, wheelLabel: e.target.value })} placeholder="Fuel Maverick 20&quot;" className="w-full" />
          </Field>
          <Field label="Tire Size">
            <input value={form.tireSize} onChange={(e) => setForm({ ...form, tireSize: e.target.value })} placeholder="275/55R20" className="w-full" />
          </Field>
          <Field label="Lift Kit Brand">
            <input value={form.liftKitBrand} onChange={(e) => setForm({ ...form, liftKitBrand: e.target.value })} placeholder="Rough Country" className="w-full" />
          </Field>
          <Field label="Lift Height">
            <input value={form.liftHeight} onChange={(e) => setForm({ ...form, liftHeight: e.target.value })} placeholder="3 inch leveling" className="w-full" />
          </Field>
          <Field label="Caption" wide>
            <input value={form.caption} onChange={(e) => setForm({ ...form, caption: e.target.value })} placeholder="Leveling kit + 20s — Moncton install" className="w-full" />
          </Field>
        </div>
      </div>

      <div className="glass-panel space-y-4">
        <h3 className="text-xs font-semibold tracking-wider text-gray-400 uppercase">Photos</h3>

        {!heroPhoto ? (
          <label className="btn-primary py-4 flex items-center justify-center gap-2 cursor-pointer w-full">
            <Camera className="w-5 h-5" />
            Take Hero Build Photo
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                setHeroPhoto(await readFileAsDataUrl(file));
                setEnhancedPhoto(null);
              }}
            />
          </label>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <img src={heroPhoto} alt="Raw build" className="rounded-xl border border-glass max-h-56 w-full object-cover" />
            {enhancedPhoto && (
              <img src={enhancedPhoto} alt="Enhanced build" className="rounded-xl border border-glass max-h-56 w-full object-cover" />
            )}
          </div>
        )}

        {extraPhotos.length < 3 && heroPhoto && (
          <label className="btn-secondary py-2.5 flex items-center justify-center gap-2 cursor-pointer text-sm">
            <Plus className="w-4 h-4" /> Add detail angle ({extraPhotos.length}/3)
            <input
              type="file"
              accept="image/*"
              capture="environment"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const url = await enhanceBuildPhoto(await readFileAsDataUrl(file));
                setExtraPhotos((prev) => [...prev, url].slice(0, 3));
              }}
            />
          </label>
        )}

        <div className="flex flex-wrap gap-3">
          {heroPhoto && !enhancedPhoto && (
            <button type="button" className="btn-primary py-3 px-4 flex-1" onClick={handleEnhance} disabled={processing}>
              {processing ? <RotateCw className="w-4 h-4 animate-spin" /> : null}
              {processing ? 'Enhancing…' : 'Enhance for Gallery'}
            </button>
          )}
          {heroPhoto && (
            <button type="button" className="btn-secondary py-3 px-4" onClick={() => { setHeroPhoto(null); setEnhancedPhoto(null); }}>
              <Trash2 className="w-4 h-4" /> Retake Hero
            </button>
          )}
          {enhancedPhoto && (
            <button type="button" className="btn-primary py-3 px-4 flex-1" onClick={handlePublish} disabled={publishing}>
              {publishing ? <RotateCw className="w-4 h-4 animate-spin" /> : <CheckCircle className="w-4 h-4" />}
              Publish to Website Gallery
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`space-y-1 ${wide ? 'col-span-2' : ''}`}>
      <label className="block text-xs font-semibold text-gray-500 uppercase">{label}</label>
      {children}
    </div>
  );
}
