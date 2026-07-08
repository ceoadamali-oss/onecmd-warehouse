import { useRef } from 'react';
import { Camera } from 'lucide-react';

export type ScanAccent = 'lime' | 'cyan' | 'amber' | 'violet' | 'emerald';

interface ScanViewfinderProps {
  label: string;
  hint?: string;
  accent?: ScanAccent;
  scanning?: boolean;
  onCapture: (base64: string) => void;
}

export function ScanViewfinder({
  label,
  hint = 'Point camera straight at the tire sticker',
  accent = 'violet',
  scanning = false,
  onCapture,
}: ScanViewfinderProps) {
  const fileRef = useRef<HTMLInputElement>(null);

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === 'string') {
        onCapture(reader.result);
      }
    };
    reader.readAsDataURL(file);
    e.target.value = '';
  };

  return (
    <>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className={`scan-viewfinder scan-viewfinder--${accent}${scanning ? ' is-scanning' : ''}`}
        aria-label={label}
      >
        <div className="scan-viewfinder__frame">
          <span className="scan-viewfinder__corner scan-viewfinder__corner--tl" aria-hidden="true" />
          <span className="scan-viewfinder__corner scan-viewfinder__corner--tr" aria-hidden="true" />
          <span className="scan-viewfinder__corner scan-viewfinder__corner--bl" aria-hidden="true" />
          <span className="scan-viewfinder__corner scan-viewfinder__corner--br" aria-hidden="true" />
          {scanning && <span className="scan-viewfinder__laser" aria-hidden="true" />}
          <Camera className="scan-viewfinder__icon" aria-hidden="true" />
        </div>
        <span className="scan-viewfinder__label">{label}</span>
        <span className="scan-viewfinder__hint">{hint}</span>
      </button>
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleChange}
        className="sr-only"
      />
    </>
  );
}
