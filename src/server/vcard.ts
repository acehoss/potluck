/**
 * vCard 3.0 emitter (REWORK P5, Round C) — the contact-import mechanism a web
 * app can offer (browsers can't write the OS address book directly). Pure
 * functions, unit-tested for the RFC 2426 text escaping: a backslash,
 * comma, semicolon, or newline inside any value must be escaped, or a name
 * like "Smith; Jane" would corrupt the structured ADR/N fields or truncate the
 * record. Backslash is escaped FIRST so the escapes introduced for the other
 * three are not themselves re-escaped.
 */

/** Escape one text value per RFC 2426 (order-sensitive; backslash first). */
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

export type VcardNameParts = {
  family: string;
  given: string;
  additional: string;
  prefix: string;
  suffix: string;
  nickname: string | null;
};

const NAME_PREFIXES = new Set(['mr', 'mrs', 'ms', 'miss', 'mx', 'dr', 'prof', 'rev', 'fr']);
const NAME_SUFFIXES = new Set(['jr', 'sr', 'ii', 'iii', 'iv', 'v', 'esq', 'phd', 'md', 'dds']);

function normalizedAffix(value: string): string {
  return value.toLowerCase().replace(/\./g, '');
}

/**
 * Derive the structured vCard N fields from the app's single display-name
 * value. Human names are not reliably parseable, so this stays deliberately
 * conservative: recognize a small set of common affixes, use the first and
 * last remaining tokens as given/family names, and treat interior tokens as
 * additional names. A standalone quoted name becomes NICKNAME instead of a
 * fake middle name. FN still preserves the original display name verbatim.
 */
export function vcardNameParts(value: string): VcardNameParts {
  const display = value.trim();
  const nicknameMatch = display.match(/(?:^|\s)["“]([^"”]+)["”](?=\s|$)/u);
  const nickname = nicknameMatch?.[1]?.trim() || null;
  const withoutNickname = nicknameMatch ? display.replace(nicknameMatch[0], ' ').trim() : display;
  const tokens = withoutNickname.split(/\s+/).filter(Boolean);

  let prefix = '';
  let suffix = '';
  if (tokens.length > 1 && NAME_PREFIXES.has(normalizedAffix(tokens[0]))) {
    prefix = tokens.shift()!;
  }
  if (tokens.length > 1 && NAME_SUFFIXES.has(normalizedAffix(tokens[tokens.length - 1]))) {
    suffix = tokens.pop()!;
  }

  const given = tokens.shift() ?? nickname ?? display;
  const family = tokens.length > 0 ? tokens.pop()! : '';
  const additional = tokens.join(' ');
  return { family, given, additional, prefix, suffix, nickname };
}

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
  const name = vcardNameParts(fields.name);
  lines.push(
    `N:${[name.family, name.given, name.additional, name.prefix, name.suffix]
      .map(vcardEscape)
      .join(';')}`,
  );
  lines.push(`FN:${vcardEscape(fields.name)}`);
  if (name.nickname) lines.push(`NICKNAME:${vcardEscape(name.nickname)}`);
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
