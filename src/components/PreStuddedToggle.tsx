import { Sparkles } from 'lucide-react';

interface PreStuddedToggleProps {
  enabled: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}

export function PreStuddedToggle({
  enabled,
  onChange,
  disabled = false,
}: PreStuddedToggleProps) {
  return (
    <div className={`winter-approved-toggle${enabled ? ' is-on' : ''}`} style={{ marginTop: '1rem' }}>
      <div className="winter-approved-toggle__copy">
        <div className="winter-approved-toggle__title">
          <Sparkles size={18} aria-hidden="true" style={{ color: enabled ? '#d97706' : '#94a3b8' }} />
          <span>Pre-Studded Tire (+ $25.00)</span>
        </div>
        <p className="winter-approved-toggle__hint">
          Flag if this tire is pre-studded. This automatically appends -STUDDED to the SKU and adds $25.00 to the price before taxes.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        disabled={disabled}
        className="winter-approved-toggle__switch"
        onClick={() => onChange(!enabled)}
      >
        <span className="winter-approved-toggle__knob" />
      </button>
    </div>
  );
}
