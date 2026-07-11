import { useRef, useState } from 'react';
import { Camera } from 'lucide-react';
import { compressImageForScan, readFileAsDataUrl } from '../lib/imageStudio';

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
  const [compressing, setCompressing] = useState(false);

  const handleChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = '';
    setCompressing(true);
    try {
      const compressed = await compressImageForScan(file);
      onCapture(compressed);
    } catch {
      try {
        onCapture(await readFileAsDataUrl(file));
      } catch {
        // User can retake if both compression and read fail
      }
    } finally {
      setCompressing(false);
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => fileRef.current?.click()}
        className={`scan-viewfinder scan-viewfinder--${accent}${scanning || compressing ? ' is-scanning' : ''}`}
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
