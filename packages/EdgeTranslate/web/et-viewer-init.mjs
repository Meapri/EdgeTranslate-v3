// EdgeTranslate PDF.js viewer bootstrap (MV3-safe: no inline script)
import * as PDFJS from '../build/pdf.mjs';

// Expose as global for viewer.mjs
if (!globalThis.pdfjsLib) {
  globalThis.pdfjsLib = PDFJS;
}

try {
  PDFJS.GlobalWorkerOptions.workerSrc = '../build/pdf.worker.mjs';
} catch {}

// Prepare URL before loading viewer.mjs, following official behavior where file param drives initial load
(async () => {
  const urlObj = new URL(location.href);
  const params = urlObj.searchParams;
  const fileParam = params.get('file');

  if (fileParam) {
    // Decode and normalize target URL
    let rawUrl = fileParam;
    try { rawUrl = decodeURIComponent(fileParam); } catch {}

    let target;
    try { target = new URL(rawUrl, location.href); } catch { target = null; }

    if (target && target.origin !== location.origin) {
      // Cross-origin: preload then point file param at same-origin blob URL before viewer runs
      try {
        const res = await fetch(target.href);
        const blob = await res.blob();
        const blobUrl = URL.createObjectURL(blob);
        params.set('file', encodeURIComponent(blobUrl));
        history.replaceState(null, '', urlObj.pathname + '?' + params.toString() + urlObj.hash);
      } catch (e) {
        console.warn('[EdgeTranslate] PDF preload failed:', e);
        // keep original param; viewer will likely fail, but we proceed
      }
    }
  }

  // Load official viewer once URL is finalized
  const script = document.createElement('script');
  script.type = 'module';
  script.src = 'viewer.mjs';
  document.head.appendChild(script);
})();


