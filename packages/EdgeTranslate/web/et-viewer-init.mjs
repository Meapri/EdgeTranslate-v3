// EdgeTranslate PDF.js viewer bootstrap (MV3-safe: no inline script)
import * as PDFJS from '../build/build/pdf.mjs';
import { applyEarlyThemeFromStorageAndSystem, applyEarlyPageTheme, setupThemeToggle } from './et-viewer-theme.mjs?v=20260509-pdf-ui-goal3';
import { setupSecondaryToolbarScroll } from './et-viewer-secondary-toolbar.mjs';
import {
  decodePdfViewerUrlParam,
  parsePdfTarget,
  setPdfViewerSearchParam,
  shouldPreloadPdfAsBlob,
} from './edge-viewer-file.js';

// Expose as global for viewer.mjs
if (!globalThis.pdfjsLib) {
  globalThis.pdfjsLib = PDFJS;
}

// Soften noisy runtime errors (benign cases: asset download hiccups, user-cancelled print)
try {
  const isHarmlessIconError = (val) => {
    const msg = String(val && (val.message || val));
    return msg.includes('Unable to download all specified images');
  };
  const isBenignCancellation = (val) => {
    if (!val) return false;
    if (val.name === 'RenderingCancelledException') return true;
    const msg = String(val.message || val);
    return msg.includes('Print cancelled');
  };
  window.addEventListener('unhandledrejection', (event) => {
    if (isHarmlessIconError(event.reason) || isBenignCancellation(event.reason)) {
      event.preventDefault();
    }
  });
  const origErr = console.error;
  console.error = function (...args) {
    if (args.some(isHarmlessIconError) || args.some(isBenignCancellation)) return;
    return origErr.apply(this, args);
  };
} catch {}

  try { PDFJS.GlobalWorkerOptions.workerSrc = '../build/build/pdf.worker.mjs'; } catch {}

function xhrPdfBlob(url) {
  return new Promise((resolve, reject) => {
    try {
      const request = new XMLHttpRequest();
      request.open('GET', url, true);
      request.responseType = 'blob';
      request.onload = () => {
        const blob = request.response;
        if (blob && blob.size !== 0) {
          resolve(blob);
          return;
        }
        reject(new Error(`Empty PDF response for ${url}`));
      };
      request.onerror = () => reject(new Error(`Unable to read PDF from ${url}`));
      request.ontimeout = () => reject(new Error(`Timed out reading PDF from ${url}`));
      request.send();
    } catch (error) {
      reject(error);
    }
  });
}

async function readPdfBlob(url) {
  let fetchError;
  try {
    const response = await fetch(url);
    if (!response.ok && response.status !== 0) {
      throw new Error(`Unexpected PDF response ${response.status}`);
    }
    const blob = await response.blob();
    if (blob && blob.size !== 0) return blob;
    throw new Error(`Empty PDF response for ${url}`);
  } catch (error) {
    fetchError = error;
  }

  try {
    const target = new URL(url, location.href);
    if (target.protocol === 'file:') return await xhrPdfBlob(target.href);
  } catch {}

  throw fetchError;
}

// Prepare URL before loading viewer.mjs, following official behavior where file param drives initial load
(async () => {
  const DEBUG = false;
  applyEarlyThemeFromStorageAndSystem();

  // Apply persisted page theme (auto|light|dark) early to avoid flicker
  applyEarlyPageTheme();
  const urlObj = new URL(location.href);
  const params = urlObj.searchParams;
  const fileParam = params.get('file');

  if (fileParam) {
    // Decode and normalize target URL. URLSearchParams serializes values for us;
    // pre-encoding blob: URLs here makes PDF.js treat them as relative paths.
    const rawUrl = decodePdfViewerUrlParam(fileParam);
    if (rawUrl !== fileParam) {
      setPdfViewerSearchParam(params, 'file', rawUrl);
      history.replaceState(null, '', urlObj.pathname + '?' + params.toString() + urlObj.hash);
    }

    const target = parsePdfTarget(rawUrl, location.href);

    const isBlobUrl = typeof rawUrl === 'string' && rawUrl.startsWith('blob:');
    const sourceParam = params.get('source');

    // If we're reloading with a blob: URL, rehydrate it from original source when available
    // Keep track of created blob URLs to revoke later
    const createdBlobUrls = (window.__etCreatedBlobUrls ||= new Set());
    window.addEventListener('unload', () => {
      try {
        for (const u of createdBlobUrls) {
          try { URL.revokeObjectURL(u); } catch {}
        }
        createdBlobUrls.clear();
      } catch {}
    }, { once: true });

    if (isBlobUrl && sourceParam) {
      try {
        const original = decodePdfViewerUrlParam(sourceParam);
        const blob = await readPdfBlob(original);
        const blobUrl = URL.createObjectURL(blob);
        try { createdBlobUrls.add(blobUrl); } catch {}
        setPdfViewerSearchParam(params, 'file', blobUrl);
        history.replaceState(null, '', urlObj.pathname + '?' + params.toString() + urlObj.hash);
      } catch (e) {
        console.warn('[EdgeTranslate] PDF blob rehydration failed:', e);
      }
    } else if (shouldPreloadPdfAsBlob({ rawUrl, viewerOrigin: location.origin, baseUrl: location.href })) {
      // Cross-origin: preload then point file param at same-origin blob URL before viewer runs
      try {
        const blob = await readPdfBlob(target.href);
        const blobUrl = URL.createObjectURL(blob);
        try { createdBlobUrls.add(blobUrl); } catch {}
        // Preserve original URL for refresh recovery
        setPdfViewerSearchParam(params, 'source', target.href);
        setPdfViewerSearchParam(params, 'file', blobUrl);
        history.replaceState(null, '', urlObj.pathname + '?' + params.toString() + urlObj.hash);
      } catch (e) {
        console.warn('[EdgeTranslate] PDF preload failed:', e);
        // keep original param; viewer will likely fail, but we proceed
      }
    }
  }

  // Load official viewer once URL is finalized (avoid duplicate insert)
  const ensureViewerLoaded = () => {
    if (document.getElementById('et-viewer-loader')) return;
    const script = document.createElement('script');
    script.type = 'module';
    script.src = 'viewer.mjs';
    script.id = 'et-viewer-loader';
    document.head.appendChild(script);
  };
  ensureViewerLoaded();

  // Theme toggle handled in et-viewer-theme.mjs

  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', setupThemeToggle);
  } else {
    // Try immediately; if button not yet available, retry shortly
    if (!setupThemeToggle()) {
      setTimeout(setupThemeToggle, 0);
    }
  }

  // Secondary toolbar handled in et-viewer-secondary-toolbar.mjs

  const trySetupToolbar = () => { if (!setupSecondaryToolbarScroll()) setTimeout(trySetupToolbar, 50); };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', trySetupToolbar);
  } else {
    trySetupToolbar();
  }

  const setupViewsManagerWheelScroll = () => {
    const manager = document.getElementById('viewsManager');
    const content = document.getElementById('viewsManagerContent');
    if (!manager || !content) return false;
    if (manager.dataset.etWheelScroll === 'true') return true;
    manager.dataset.etWheelScroll = 'true';

    const normalizeWheelDelta = (event) => {
      let delta = event.deltaY;
      if (event.deltaMode === WheelEvent.DOM_DELTA_LINE) {
        delta *= 16;
      } else if (event.deltaMode === WheelEvent.DOM_DELTA_PAGE) {
        delta *= content.clientHeight || 1;
      }
      return delta;
    };

    manager.addEventListener('wheel', (event) => {
      if (Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      if (content.scrollHeight <= content.clientHeight + 1) return;

      const before = content.scrollTop;
      const maxScrollTop = content.scrollHeight - content.clientHeight;
      const next = Math.min(maxScrollTop, Math.max(0, before + normalizeWheelDelta(event)));
      if (next === before) return;

      content.scrollTop = next;
      event.preventDefault();
      event.stopPropagation();
    }, { capture: true, passive: false });
    return true;
  };
  const trySetupViewsManagerWheelScroll = () => {
    if (!setupViewsManagerWheelScroll()) setTimeout(trySetupViewsManagerWheelScroll, 50);
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', trySetupViewsManagerWheelScroll);
  } else {
    trySetupViewsManagerWheelScroll();
  }

  // Close any open PDF.js doorhangers/menus when clicking the background
  const setupGlobalMenuDismissal = () => {
    const isMenuElement = (el) => !!(el && el.classList && (el.classList.contains('menu') || el.classList.contains('doorHanger') || el.classList.contains('doorHangerRight')));
    const closeAllMenus = () => {
      try {
        const menus = document.querySelectorAll('.menu, .doorHanger, .doorHangerRight');
        for (const el of menus) {
          if (el.classList && !el.classList.contains('hidden')) {
            el.classList.add('hidden');
            const id = el.id;
            if (id) {
              const controller = document.querySelector(`[aria-controls="${CSS.escape(id)}"]`);
              if (controller && controller.getAttribute('aria-expanded') === 'true') {
                controller.setAttribute('aria-expanded', 'false');
              }
            }
          }
        }
      } catch {}
    };
    const onPointerDown = (e) => {
      let node = e.target;
      while (node) {
        if (isMenuElement(node)) return; // Click inside an open menu → don't auto-close
        node = node.parentNode;
      }
      closeAllMenus();
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    return true;
  };
  setupGlobalMenuDismissal();

  const setupDocumentPropertiesDialog = () => {
    const dialog = document.getElementById('documentPropertiesDialog');
    if (!dialog) return false;
    const resetScroll = () => {
      requestAnimationFrame(() => {
        try { dialog.scrollTop = 0; } catch {}
      });
    };
    const normalizeTitle = () => {
      try {
        const title = dialog.querySelector('.et-document-properties-header > span');
        if (title && title.textContent) title.textContent = title.textContent.replace(/[.…]+$/u, '');
      } catch {}
    };
    const observer = new MutationObserver(() => {
      if (dialog.open || dialog.hasAttribute('open')) {
        normalizeTitle();
        resetScroll();
      }
    });
    try { observer.observe(dialog, { attributes: true, attributeFilter: ['open'] }); } catch {}
    document.getElementById('documentProperties')?.addEventListener('click', () => {
      setTimeout(normalizeTitle, 0);
      setTimeout(resetScroll, 0);
      setTimeout(normalizeTitle, 80);
      setTimeout(resetScroll, 80);
    });
    return true;
  };
  const trySetupDocumentPropertiesDialog = () => {
    if (!setupDocumentPropertiesDialog()) setTimeout(trySetupDocumentPropertiesDialog, 50);
  };
  if (document.readyState === 'loading') {
    window.addEventListener('DOMContentLoaded', trySetupDocumentPropertiesDialog);
  } else {
    trySetupDocumentPropertiesDialog();
  }
})();
