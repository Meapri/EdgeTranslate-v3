function parsePdfTarget(rawUrl, baseUrl) {
  try {
    return new URL(rawUrl, baseUrl);
  } catch (_) {
    return null;
  }
}

function isExtensionViewerOrigin(origin) {
  return /^(chrome|moz|safari-web)-extension:\/\//.test(origin || '');
}

function shouldPreloadPdfAsBlob({ rawUrl, viewerOrigin, baseUrl }) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  if (rawUrl.startsWith('blob:')) return false;

  const target = parsePdfTarget(rawUrl, baseUrl || viewerOrigin);
  if (!target) return false;

  // PDF.js validates the ?file= URL before opening it. A file:// URL has a
  // different origin from chrome-extension:// / moz-extension://, so passing it
  // through directly throws "file origin does not match viewer's" and leaves the
  // viewer blank. Preload local PDFs as same-origin blob: URLs when the viewer is
  // running inside the extension; this still requires the browser's file-URL
  // access permission to be enabled for local files.
  if (target.protocol === 'file:') return isExtensionViewerOrigin(viewerOrigin);

  return target.origin !== viewerOrigin;
}

function looksLikePdfViewerUrl(value) {
  return /^(blob|file|https?|chrome-extension|moz-extension|safari-web-extension):/i.test(value || '');
}

function looksLikeEncodedPdfViewerUrl(value) {
  return /^(blob|file|https?|chrome-extension|moz-extension|safari-web-extension)%3a/i.test(value || '');
}

function decodePdfViewerUrlParam(value) {
  if (typeof value !== 'string') return value;

  let current = value;
  for (let i = 0; i < 2; i += 1) {
    let decoded = current;
    try {
      decoded = decodeURIComponent(current);
    } catch (_) {
      break;
    }
    if (decoded === current) break;
    if (!looksLikePdfViewerUrl(decoded) && !looksLikeEncodedPdfViewerUrl(decoded)) break;
    current = decoded;
  }
  return current;
}

function setPdfViewerSearchParam(params, name, value) {
  params.set(name, value);
}

function asArray(value) {
  try {
    return Array.from(value || []);
  } catch (_) {
    return [];
  }
}

function isPdfLikeName(name) {
  return typeof name === 'string' && /\.pdf(?:$|[?#])/i.test(name.trim());
}

function isPdfLikeFile(file) {
  if (!file) return false;
  return file.type === 'application/pdf' || isPdfLikeName(file.name);
}

function isExternalFileDragData(dataTransfer) {
  if (!dataTransfer) return false;

  const types = asArray(dataTransfer.types);
  if (types.includes('Files')) return true;

  const items = asArray(dataTransfer.items);
  if (items.some((item) => item && item.kind === 'file')) return true;

  return asArray(dataTransfer.files).length > 0;
}

function isPdfFileDragData(dataTransfer) {
  if (!isExternalFileDragData(dataTransfer)) return false;

  const files = asArray(dataTransfer.files);
  if (files.some(isPdfLikeFile)) return true;

  const items = asArray(dataTransfer.items);
  return items.some((item) => {
    if (!item || item.kind !== 'file') return false;
    if (item.type === 'application/pdf') return true;
    try {
      return isPdfLikeFile(item.getAsFile && item.getAsFile());
    } catch (_) {
      return false;
    }
  });
}

function shouldBlockPdfDropHijack() {
  return false;
}

export {
  decodePdfViewerUrlParam,
  isExtensionViewerOrigin,
  isPdfFileDragData,
  parsePdfTarget,
  setPdfViewerSearchParam,
  shouldBlockPdfDropHijack,
  shouldPreloadPdfAsBlob,
};
