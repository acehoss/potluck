/**
 * Barcode helpers (blueprint 04 §2). Pure functions, unit-tested — the camera
 * loop itself needs real hardware and is tracked for on-device verification in ROADMAP.md.
 */

/**
 * Normalize a scanned retail code for product lookup/storage.
 *
 * US products carry UPC-A (12 digits); scanners (zxing included) often report
 * the same symbol as EAN-13 with a leading zero. Store and search the
 * 12-digit form so a scan matches a hand-typed UPC from the package and vice
 * versa. Non-retail junk (wrong length, non-digits) returns null.
 */
export function normalizeScannedCode(rawValue: string): string | null {
  const digits = rawValue.trim();
  if (!/^\d{8,14}$/.test(digits)) return null;
  if (digits.length === 13 && digits.startsWith('0')) return digits.slice(1);
  return digits;
}

/** Whether a product-picker query should also be matched against Product.upc. */
export function looksLikeUpcQuery(query: string): boolean {
  return /^\d{8,14}$/.test(query.trim());
}
