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

/** Upload a JPEG blob to /api/upload/[kind]; returns the stored relative path. */
export async function uploadImage(kind: 'receipts' | 'units' | 'items', blob: Blob) {
  const form = new FormData();
  form.append('file', new File([blob], 'photo.jpg', { type: 'image/jpeg' }));
  const res = await fetch(`/api/upload/${kind}`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`upload failed: ${res.status}`);
  return (await res.json()).path as string;
}
