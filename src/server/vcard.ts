/**
 * vCard 3.0 emitter (REWORK P5, Round C) — the contact-import mechanism a web
 * app can offer (browsers can't write the OS address book directly). Pure
 * functions, unit-tested for the RFC 6350 §3.4 text escaping: a backslash,
 * comma, semicolon, or newline inside any value must be escaped, or a name
 * like "Smith; Jane" would corrupt the structured ADR/N fields or truncate the
 * record. Backslash is escaped FIRST so the escapes introduced for the other
 * three are not themselves re-escaped.
 */

/** Escape one text value per RFC 6350 §3.4 (order-sensitive; backslash first). */
import { phoneHref } from '../lib/phone';

export function vcardEscape(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/\r\n|\r|\n/g, '\\n')
    .replace(/,/g, '\\,')
    .replace(/;/g, '\\;');
}

export type VcardFields = {
  name: string;
  org: string;
  email: string;
  phone?: string | null;
  address?: string | null;
  bio?: string | null;
};

/**
 * Build a VERSION:3.0 vCard. Lines are CRLF-joined per spec. TEL is TYPE=CELL
 * (the card's phone is a mobile in this app's model) and carries the E.164-ish
 * `phoneHref` normalization (`+1…` for US numbers) so the imported contact dials
 * correctly regardless of how the stored string was formatted. The free-text household
 * address goes in the ADR street component (3rd of the 7 semicolon-separated
 * fields) — the whole location as one escaped run, which readers render fine.
 */
export function buildVcard(fields: VcardFields): string {
  const lines = ['BEGIN:VCARD', 'VERSION:3.0'];
  lines.push(`FN:${vcardEscape(fields.name)}`);
  lines.push(`ORG:${vcardEscape(fields.org)}`);
  if (fields.phone) lines.push(`TEL;TYPE=CELL:${phoneHref(fields.phone)}`);
  lines.push(`EMAIL:${vcardEscape(fields.email)}`);
  if (fields.address) lines.push(`ADR;TYPE=HOME:;;${vcardEscape(fields.address)};;;;`);
  if (fields.bio) lines.push(`NOTE:${vcardEscape(fields.bio)}`);
  lines.push('END:VCARD');
  return lines.join('\r\n') + '\r\n';
}

/**
 * A Content-Disposition value for a "{name}.vcf" download. The quoted form
 * strips characters that would break the header (quotes, backslashes, control
 * chars); filename* carries the exact UTF-8 name for modern clients (RFC 5987).
 */
export function vcardContentDisposition(name: string): string {
  const base = name.trim() || 'contact';
  const ascii = base.replace(/[\\"\r\n]/g, '').replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(`${base}.vcf`);
  return `attachment; filename="${ascii}.vcf"; filename*=UTF-8''${encoded}`;
}
