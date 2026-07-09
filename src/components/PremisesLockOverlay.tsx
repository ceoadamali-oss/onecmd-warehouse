import { Lock, MapPin, LogOut, RotateCw } from 'lucide-react';
import type { StoreId } from '../lib/storeLocations';

type PremisesLockOverlayProps = {
  gpsError: string | null;
  nearestStoreName: string;
  distanceM: number | null;
  checking: boolean;
  onRetryGps: () => void;
  onLogout: () => void;
  nearestStoreId?: StoreId;
};

export function PremisesLockOverlay({
  gpsError,
  nearestStoreName,
  distanceM,
  checking,
  onRetryGps,
  onLogout,
}: PremisesLockOverlayProps) {
  return (
    <div className="premises-lock">
      <div className="premises-lock__card">
        <div className="premises-lock__icon">
          <Lock className="w-10 h-10" />
        </div>
        <h2 className="premises-lock__title">App Locked — Off Premises</h2>
        <p className="premises-lock__text">
          Atlantic Tire King warehouse tools only work when you are physically at one of our shop locations
          (within 100 meters). Inventory, photos, and gallery uploads are disabled until you return on-site.
        </p>

        <div className="premises-lock__status">
          {checking ? (
            <span className="premises-lock__checking">
              <RotateCw className="w-4 h-4 animate-spin" /> Verifying GPS location…
            </span>
          ) : gpsError ? (
            <span className="premises-lock__error">{gpsError}</span>
          ) : (
            <span className="premises-lock__distance">
              <MapPin className="w-4 h-4" />
              Nearest: {nearestStoreName}
              {distanceM != null ? ` — ${distanceM}m away` : ''}
            </span>
          )}
        </div>

        <div className="premises-lock__actions">
          <button type="button" className="btn-primary py-3 px-5" onClick={onRetryGps}>
            <RotateCw className="w-4 h-4" /> Check Location Again
          </button>
          <button type="button" className="btn-secondary py-3 px-5" onClick={onLogout}>
            <LogOut className="w-4 h-4" /> Log Out
          </button>
        </div>
      </div>
    </div>
  );
}
