function parsePdfTarget(rawUrl, baseUrl) {
  try {
    return new URL(rawUrl, baseUrl);
  } catch (_) {
    return null;
  }
}

function shouldPreloadPdfAsBlob({ rawUrl, viewerOrigin, baseUrl }) {
  if (!rawUrl || typeof rawUrl !== 'string') return false;
  if (rawUrl.startsWith('blob:')) return false;

  const target = parsePdfTarget(rawUrl, baseUrl || viewerOrigin);
  if (!target) return false;

  // Local files should stay as file:// URLs. When the user enables
  // "Allow access to file URLs", PDF.js can load them directly; trying to
  // fetch-and-blob them from the extension page commonly fails and leaves a
  // blank viewer.
  if (target.protocol === 'file:') return false;

  return target.origin !== viewerOrigin;
}

export { parsePdfTarget, shouldPreloadPdfAsBlob };
