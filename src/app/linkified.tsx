import { Fragment } from 'react';

export type LinkSegment =
  | { type: 'text'; value: string }
  | { type: 'link'; value: string };

// Only http/https by construction — anything else stays plain text.
const URL_RE = /https?:\/\/[^\s]+/g;
// Punctuation that commonly trails a URL in prose and must not be captured
// into the href (spec §4): . , ; : ! ? )
const TRAILING_RE = /[.,;:!?)]+$/;

/**
 * Split `text` into plain-text and http(s)-link segments (media round §4).
 * Pure — no React — so the unit test imports it directly. Trailing sentence
 * punctuation is pushed back into the following text node, never swallowed
 * into the URL. Adjacent text nodes are coalesced.
 */
export function linkifySegments(text: string): LinkSegment[] {
  const out: LinkSegment[] = [];
  let last = 0;

  const pushText = (value: string) => {
    if (!value) return;
    const prev = out[out.length - 1];
    if (prev && prev.type === 'text') prev.value += value;
    else out.push({ type: 'text', value });
  };

  for (const match of text.matchAll(URL_RE)) {
    const start = match.index ?? 0;
    const raw = match[0];
    const trailing = raw.match(TRAILING_RE)?.[0] ?? '';
    const url = trailing ? raw.slice(0, raw.length - trailing.length) : raw;

    pushText(text.slice(last, start));
    // A run of pure punctuation (no scheme host left) degrades to text.
    if (url.length > 'https://'.length) out.push({ type: 'link', value: url });
    else pushText(url);
    pushText(trailing);
    last = start + raw.length;
  }
  pushText(text.slice(last));
  return out;
}

/**
 * Render text with bare http(s) URLs turned into anchors. No markdown, no
 * dangerouslySetInnerHTML — segment then map. Keep the surrounding block's
 * `whitespace-pre-line` so newlines still render.
 */
export function Linkified({ text }: { text: string }) {
  return (
    <>
      {linkifySegments(text).map((seg, i) =>
        seg.type === 'link' ? (
          <a
            key={i}
            href={seg.value}
            target="_blank"
            rel="noopener noreferrer"
            className="text-accent underline underline-offset-2 hover:text-accent-strong"
          >
            {seg.value}
          </a>
        ) : (
          <Fragment key={i}>{seg.value}</Fragment>
        ),
      )}
    </>
  );
}
