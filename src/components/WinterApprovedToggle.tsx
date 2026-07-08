import { Snowflake } from 'lucide-react';

interface WinterApprovedToggleProps {
  enabled: boolean;
  onChange: (value: boolean) => void;
  aiDetected?: boolean;
  disabled?: boolean;
}

export function WinterApprovedToggle({
  enabled,
  onChange,
  aiDetected,
  disabled = false,
}: WinterApprovedToggleProps) {
  return (
    <div className={`winter-approved-toggle${enabled ? ' is-on' : ''}`}>
      <div className="winter-approved-toggle__copy">
        <div className="winter-approved-toggle__title">
          <Snowflake size={18} aria-hidden="true" />
          <span>3PMSF · Winter Approved</span>
        </div>
        <p className="winter-approved-toggle__hint">
          {aiDetected
            ? 'AI detected the mountain-snowflake symbol on this sticker. Confirm or turn off if wrong.'
            : 'Turn on if this tire carries the three-peak mountain snowflake (Veteran, Battlefield, Aquishi, etc.).'}
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
