import { Lock, LogOut, RotateCw } from 'lucide-react';

type PremisesLockOverlayProps = {
  gpsError: string | null;
  checking: boolean;
  onRetryGps: () => void;
  onLogout: () => void;
};

export function PremisesLockOverlay({
  gpsError,
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
        <h2 className="premises-lock__title">App Locked</h2>
        <p className="premises-lock__text">
          This app is only available at authorized Atlantic Tire King locations.
        </p>

        <div className="premises-lock__status">
          {checking ? (
            <span className="premises-lock__checking">
              <RotateCw className="w-4 h-4 animate-spin" /> Verifying access…
            </span>
          ) : gpsError ? (
            <span className="premises-lock__error">Location could not be verified. Please try again.</span>
          ) : null}
        </div>

        <div className="premises-lock__actions">
          <button type="button" className="btn-primary py-3 px-5" onClick={onRetryGps}>
            <RotateCw className="w-4 h-4" /> Try Again
          </button>
          <button type="button" className="btn-secondary py-3 px-5" onClick={onLogout}>
            <LogOut className="w-4 h-4" /> Log Out
          </button>
        </div>
      </div>
    </div>
  );
}
