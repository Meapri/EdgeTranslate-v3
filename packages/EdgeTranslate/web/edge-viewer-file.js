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

export { parsePdfTarget, shouldPreloadPdfAsBlob };
