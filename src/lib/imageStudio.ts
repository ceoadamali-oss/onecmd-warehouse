/** Composite a transparent PNG onto a clean white studio background */
export async function compositeOnWhiteBackground(transparentDataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      const pad = Math.round(Math.max(img.width, img.height) * 0.08);
      canvas.width = img.width + pad * 2;
      canvas.height = img.height + pad * 2;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas not supported'));
        return;
      }
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, pad, pad, img.width, img.height);
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.onerror = () => reject(new Error('Failed to load processed image'));
    img.src = transparentDataUrl;
  });
}

/** Light enhancement for customer build / truck photos */
export async function enhanceBuildPhoto(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas not supported'));
        return;
      }
      ctx.filter = 'contrast(1.08) saturate(1.12) brightness(1.04)';
      ctx.drawImage(img, 0, 0);
      resolve(canvas.toDataURL('image/jpeg', 0.9));
    };
    img.onerror = () => reject(new Error('Failed to load build photo'));
    img.src = dataUrl;
  });
}

export async function processProductStudioPhoto(rawDataUrl: string): Promise<string> {
  const res = await fetch('/api/remove-background', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ base64Image: rawDataUrl }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(err || 'Background removal failed');
  }
  const data = await res.json();
  if (!data.transparentImage) throw new Error('No processed image returned');
  return compositeOnWhiteBackground(data.transparentImage);
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read image file'));
    reader.readAsDataURL(file);
  });
}

/** Conservative resize for warehouse sticker scans — keeps OCR detail, cuts payload size. */
const SCAN_MAX_WIDTH = 1600;
const SCAN_JPEG_QUALITY = 0.85;

export async function compressDataUrlForScan(dataUrl: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      let { width, height } = img;
      if (width > SCAN_MAX_WIDTH) {
        height = Math.round(height * (SCAN_MAX_WIDTH / width));
        width = SCAN_MAX_WIDTH;
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Canvas not supported'));
        return;
      }
      ctx.drawImage(img, 0, 0, width, height);
      resolve(canvas.toDataURL('image/jpeg', SCAN_JPEG_QUALITY));
    };
    img.onerror = () => reject(new Error('Failed to load image for compression'));
    img.src = dataUrl;
  });
}

export async function compressImageForScan(file: File): Promise<string> {
  const dataUrl = await readFileAsDataUrl(file);
  return compressDataUrlForScan(dataUrl);
}
