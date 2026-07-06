/**
 * Unit tests for the recipe-import image path (REWORK R3) — the parts e2e can't
 * reach because the SSRF guard blocks localhost and CI has no outbound network:
 * the og:image fallback + candidate ordering (pure), and guardedImageFetch's
 * content-type / JPEG-magic / SSRF gates (global.fetch stubbed — no real net).
 *
 * Run: npm run test:unit  (tsx --test; part of the definition of done)
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  downloadFirstJpeg,
  extractRecipe,
  guardedImageFetch,
  recipeImageCandidates,
} from './recipe-import';

const ORIG_FETCH = globalThis.fetch;

const JPEG = [0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46];
const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function imgResponse(bytes: number[], contentType: string): Response {
  return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': contentType } });
}

/** JSON-LD recipe with an optional `image`, plus optional og/twitter meta. */
function page(opts: { ldImage?: string | string[]; og?: string; twitter?: string }): string {
  const node: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': 'Recipe',
    name: 'Cornbread',
    recipeIngredient: ['1 cup cornmeal', '1 cup flour'],
    recipeInstructions: 'Mix.\nBake.',
  };
  if (opts.ldImage !== undefined) node.image = opts.ldImage;
  const metas = [
    opts.og ? `<meta property="og:image" content="${opts.og}">` : '',
    opts.twitter ? `<meta name="twitter:image" content="${opts.twitter}">` : '',
  ].join('\n');
  return `<html><head>
<script type="application/ld+json">${JSON.stringify(node)}</script>
${metas}
</head><body><h1>Cornbread</h1></body></html>`;
}

const SRC = 'https://site.example.com/recipes/cornbread';

// ---- candidate ordering / og:image fallback (pure) --------------------------

test('recipeImageCandidates: JSON-LD image wins, og/twitter follow in order', () => {
  const html = page({
    ldImage: 'https://cdn.example.com/jsonld.jpg',
    og: 'https://cdn.example.com/og.jpg',
    twitter: 'https://cdn.example.com/twitter.jpg',
  });
  assert.deepEqual(recipeImageCandidates(html, 'text/html', SRC), [
    'https://cdn.example.com/jsonld.jpg',
    'https://cdn.example.com/og.jpg',
    'https://cdn.example.com/twitter.jpg',
  ]);
});

test('recipeImageCandidates: og:image is the fallback when JSON-LD has no image', () => {
  const html = page({ og: 'https://cdn.example.com/og.jpg', twitter: 'https://cdn.example.com/tw.jpg' });
  const c = recipeImageCandidates(html, 'text/html', SRC);
  assert.equal(c[0], 'https://cdn.example.com/og.jpg');
  assert.equal(c[1], 'https://cdn.example.com/tw.jpg');
});

test('recipeImageCandidates: twitter:image is last-resort', () => {
  const html = page({ twitter: 'https://cdn.example.com/tw.jpg' });
  assert.deepEqual(recipeImageCandidates(html, 'text/html', SRC), ['https://cdn.example.com/tw.jpg']);
});

test('recipeImageCandidates: relative og:image resolves against the page URL', () => {
  const html = page({ og: '/img/photo.jpg' });
  assert.deepEqual(recipeImageCandidates(html, 'text/html', SRC), [
    'https://site.example.com/img/photo.jpg',
  ]);
});

test('recipeImageCandidates: non-https candidates are dropped', () => {
  const html = page({ og: 'http://insecure.example.com/x.jpg' });
  assert.deepEqual(recipeImageCandidates(html, 'text/html', SRC), []);
});

test('recipeImageCandidates: duplicate URLs collapse, order preserved', () => {
  const html = page({
    ldImage: ['https://cdn.example.com/a.jpg', 'https://cdn.example.com/a.jpg'],
    og: 'https://cdn.example.com/a.jpg',
  });
  assert.deepEqual(recipeImageCandidates(html, 'text/html', SRC), ['https://cdn.example.com/a.jpg']);
});

test('extractRecipe: photoUrl uses the JSON-LD image over og:image', () => {
  const html = page({ ldImage: 'https://cdn.example.com/jsonld.jpg', og: 'https://cdn.example.com/og.jpg' });
  const r = extractRecipe(html, 'text/html', SRC);
  assert.equal(r?.photoUrl, 'https://cdn.example.com/jsonld.jpg');
});

test('extractRecipe: photoUrl falls back to og:image when JSON-LD lacks one', () => {
  const html = page({ og: 'https://cdn.example.com/og.jpg' });
  const r = extractRecipe(html, 'text/html', SRC);
  assert.equal(r?.photoUrl, 'https://cdn.example.com/og.jpg');
});

// ---- guardedImageFetch: content-type / JPEG magic / SSRF --------------------

test('guardedImageFetch: a real JPEG passes and returns the bytes', async (t) => {
  globalThis.fetch = (async () => imgResponse(JPEG, 'image/jpeg')) as typeof fetch;
  t.after(() => {
    globalThis.fetch = ORIG_FETCH;
  });
  const buf = await guardedImageFetch('https://cdn.example.com/a.jpg');
  assert.ok(buf, 'expected a buffer');
  assert.equal(buf![0], 0xff);
  assert.equal(buf![1], 0xd8);
});

test('guardedImageFetch: PNG bytes are rejected (JPEG-only)', async (t) => {
  globalThis.fetch = (async () => imgResponse(PNG, 'image/png')) as typeof fetch;
  t.after(() => {
    globalThis.fetch = ORIG_FETCH;
  });
  assert.equal(await guardedImageFetch('https://cdn.example.com/a.png'), null);
});

test('guardedImageFetch: a non-image content-type is rejected even with JPEG bytes', async (t) => {
  globalThis.fetch = (async () => imgResponse(JPEG, 'text/html')) as typeof fetch;
  t.after(() => {
    globalThis.fetch = ORIG_FETCH;
  });
  assert.equal(await guardedImageFetch('https://cdn.example.com/a.jpg'), null);
});

test('guardedImageFetch: SSRF-blocked URLs never fetch and return null', async (t) => {
  globalThis.fetch = (async () => {
    throw new Error('fetch should not be called for a blocked URL');
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = ORIG_FETCH;
  });
  for (const url of [
    'https://localhost/a.jpg',
    'http://cdn.example.com/a.jpg', // not https
    'https://192.168.1.1/a.jpg', // IP literal
    'https://cdn.example.com:8080/a.jpg', // non-443 port
    'https://intranet/a.jpg', // dotless host
    'https://[::1]/a.jpg', // IPv6 literal
  ]) {
    assert.equal(await guardedImageFetch(url), null, url);
  }
});

test('downloadFirstJpeg: falls through a non-JPEG candidate to the next JPEG one', async (t) => {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    return url.includes('.png') ? imgResponse(PNG, 'image/png') : imgResponse(JPEG, 'image/jpeg');
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = ORIG_FETCH;
  });
  const buf = await downloadFirstJpeg([
    'https://cdn.example.com/a.png',
    'https://cdn.example.com/b.jpg',
  ]);
  assert.ok(buf, 'expected the second candidate to download');
  assert.equal(buf![0], 0xff);
  assert.equal(buf![1], 0xd8);
});

test('downloadFirstJpeg: returns null when no candidate is a JPEG', async (t) => {
  globalThis.fetch = (async () => imgResponse(PNG, 'image/png')) as typeof fetch;
  t.after(() => {
    globalThis.fetch = ORIG_FETCH;
  });
  assert.equal(await downloadFirstJpeg(['https://cdn.example.com/a.png']), null);
});
