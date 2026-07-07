/**
 * Client-side image downscale (blueprint 04 §1): canvas resize to ≤2048px
 * long edge, JPEG q0.85. Keeps the container free of native deps and matches
 * what the VLM can use, so retained receipts stay re-extractable.
 * iPhone HEIC re-encodes to JPEG for free.
 */
export async function downscaleToJpeg(file: File, maxEdge = 2048): Promise<Blob> {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d')!.drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return new Promise((res, rej) =>
    canvas.toBlob((b) => (b ? res(b) : rej(new Error('encode failed'))), 'image/jpeg', 0.85),
  );
}

/**
 * sha256 (hex) of the ORIGINAL selected file, before the canvas re-encode
 * (whose bytes are browser/version dependent). Keys fixture-mode extraction
 * (blueprint 04 §3). Null when crypto.subtle is unavailable — non-secure
 * contexts like a LAN IP over plain http (slice-1 lesson); extraction
 * fixtures only run on localhost/TLS, so that's an acceptable degrade.
 */
export async function sha256HexOfFile(file: File): Promise<string | null> {
  if (typeof crypto === 'undefined' || !crypto.subtle) return null;
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Upload a JPEG blob to /api/upload/[kind]; returns the stored relative path
 * plus the server-validated originalSha256 echo (sent as a form field with
 * the upload; persisted onto RestockImage at attach time).
 */
export async function uploadImage(
  kind: 'receipts' | 'units' | 'items' | 'shares' | 'recipes' | 'avatars' | 'products',
  blob: Blob,
  originalSha256?: string | null,
) {
  const form = new FormData();
  form.append('file', new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
  if (originalSha256) form.append('originalSha256', originalSha256);
  const res = await fetch(`/api/upload/${kind}`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return (await res.json()) as { path: string; originalSha256: string | null };
}
