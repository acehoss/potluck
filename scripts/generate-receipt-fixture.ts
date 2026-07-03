/**
 * Regenerates the e2e receipt fixtures (blueprint 04 §1/§3): renders each
 * receipt as HTML, screenshots it to e2e/fixtures/<name>.jpg via Playwright,
 * then writes the matching extraction fixture JSON keyed by the JPEG's
 * sha256 into src/server/extraction-fixtures/ (fixture-mode extraction
 * returns exactly these lines for that image).
 *
 * Three fixtures:
 * - receipt-costco.jpg — the realistic happy path (12 clean lines).
 * - receipt-edge.jpg   — hostile model output: over-long description,
 *   out-of-range unit counts, a negative discount line, a $0 promo line;
 *   exercises the client's sanitize/drop path.
 * - receipt-empty.jpg  — extraction succeeds with zero lines.
 *
 * Run: npx tsx scripts/generate-receipt-fixture.ts
 * Commit all outputs together — the shas key the pairs.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

// One row per purchased line; unitCount = eaches in the pack.
const LINES = [
  { item: '96716', description: 'KS ORG EVOO 2L', unitCount: 1, cents: 1749, taxed: false },
  { item: '30669', description: 'KS MARINARA 3CT', unitCount: 3, cents: 899, taxed: false },
  { item: '87745', description: 'ROTISSERIE CHICKEN', unitCount: 1, cents: 499, taxed: false },
  { item: '555221', description: 'KS BATH TISSUE 30CT', unitCount: 30, cents: 2299, taxed: true },
  { item: '723105', description: 'KS PAPER TOWELS 12CT', unitCount: 12, cents: 1949, taxed: true },
  { item: '30271', description: 'ORG BANANAS 3LB', unitCount: 1, cents: 249, taxed: false },
  { item: '964212', description: 'KS ALMOND BUTTER', unitCount: 1, cents: 799, taxed: false },
  { item: '173840', description: 'CAGE FREE EGGS 24CT', unitCount: 24, cents: 679, taxed: false },
  { item: '883311', description: 'KS SPARKLING WATER 35CT', unitCount: 35, cents: 1299, taxed: true },
  { item: '55780', description: 'FROZEN BLUEBERRIES 4LB', unitCount: 1, cents: 1099, taxed: false },
  { item: '621904', description: 'KS BEEF BROTH 6CT', unitCount: 6, cents: 999, taxed: false },
  { item: '447589', description: 'TORTILLA CHIPS 2LB', unitCount: 1, cents: 549, taxed: false },
];

const SUBTOTAL = LINES.reduce((s, l) => s + l.cents, 0); // 13068
const TAX = 287;
const TOTAL = SUBTOTAL + TAX; // 13355
const PURCHASED_AT = '2026-06-28';

const dollars = (cents: number) => (cents / 100).toFixed(2);

const row = (left: string, right: string, cls = '') =>
  `<div class="row ${cls}"><span>${left}</span><span>${right}</span></div>`;

// Deterministic 240-char description — sanitize must slice it to saveLine's
// 200-char product-name cap before Confirm. (Mirrored in e2e/slice5.spec.ts;
// not exported because importing this script would run main().)
const EDGE_LONG_DESCRIPTION =
  'ORGANIC FAIR TRADE SHADE GROWN WHOLE BEAN ESPRESSO ROAST COFFEE '.repeat(4).slice(0, 240);

// Model-output edge cases (see header). Expected proposals after client
// sanitize: 3 (long-description sliced, unitCount 0 → 1, 50000 → 10000);
// the −$3.00 discount and the $0.00 promo lines are dropped, not clamped.
const EDGE_LINES = [
  { description: EDGE_LONG_DESCRIPTION, unitCount: 2, lineTotalCents: 1499, confidence: 0.41 },
  { description: 'ZERO COUNT ITEM', unitCount: 0, lineTotalCents: 399, confidence: 0.5 },
  { description: 'MEGA PACK NAPKINS', unitCount: 50_000, lineTotalCents: 2599, confidence: 0.6 },
  { description: '1234 INSTANT SVG', unitCount: 1, lineTotalCents: -300, confidence: 0.9 },
  { description: 'FREE PROMO ITEM', unitCount: 1, lineTotalCents: 0, confidence: 0.8 },
];

const html = `<!doctype html><html><head><meta charset="utf-8"><style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { background: #d8d8d4; padding: 24px; }
  .receipt {
    width: 460px; margin: 0 auto; background: #fdfdf8; color: #1a1a1a;
    font-family: "Courier New", Courier, monospace; font-size: 17px; line-height: 1.45;
    padding: 26px 22px 34px; box-shadow: 0 1px 6px rgba(0,0,0,.35);
  }
  .center { text-align: center; }
  .brand { font-size: 30px; font-weight: 700; letter-spacing: 2px; }
  .sub { font-size: 15px; }
  .rule { border-top: 1px dashed #555; margin: 10px 0; }
  .row { display: flex; justify-content: space-between; white-space: pre; }
  .bold { font-weight: 700; }
  .big { font-size: 20px; }
</style></head><body><div class="receipt">
  <div class="center brand">COSTCO</div>
  <div class="center sub">WHOLESALE</div>
  <div class="center sub">Dayton #384</div>
  <div class="center sub">6975 Miller Ln, Dayton OH</div>
  <div class="rule"></div>
  <div class="sub">Member 111792840448</div>
  <div class="rule"></div>
  ${LINES.map((l) => row(`${l.taxed ? 'A' : 'E'} ${l.item} ${l.description}`, `${dollars(l.cents)} ${l.taxed ? 'A' : ''}`)).join('\n  ')}
  <div class="rule"></div>
  ${row('SUBTOTAL', dollars(SUBTOTAL), 'bold')}
  ${row('TAX', dollars(TAX))}
  ${row('**** TOTAL', dollars(TOTAL), 'bold big')}
  <div class="rule"></div>
  ${row('XXXXXXXXXXXX4821', 'CHIP READ')}
  ${row('VISA', dollars(TOTAL))}
  <div class="rule"></div>
  <div class="sub">TOTAL NUMBER OF ITEMS SOLD = ${LINES.length}</div>
  <div class="sub">06/28/2026 14:07 384 211 143 88</div>
  <div class="center sub" style="margin-top:10px">THANK YOU!<br>PLEASE COME AGAIN</div>
</div></body></html>`;

// Plain small receipts for the edge/empty fixtures — content only matters
// visually (the sha keys the extraction JSON), but keep them receipt-shaped.
const edgeHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { background: #d8d8d4; padding: 24px; font-family: "Courier New", monospace; }
  .receipt { width: 460px; margin: 0 auto; background: #fdfdf8; padding: 26px 22px; font-size: 16px; }
  .row { display: flex; justify-content: space-between; }
</style></head><body><div class="receipt">
  <div style="text-align:center;font-weight:700">EDGE MART</div>
  <div class="row"><span style="max-width:340px;overflow:hidden">${EDGE_LONG_DESCRIPTION}</span><span>14.99</span></div>
  <div class="row"><span>ZERO COUNT ITEM</span><span>3.99</span></div>
  <div class="row"><span>MEGA PACK NAPKINS</span><span>25.99</span></div>
  <div class="row"><span>1234 INSTANT SVG</span><span>-3.00</span></div>
  <div class="row"><span>FREE PROMO ITEM</span><span>0.00</span></div>
</div></body></html>`;

const emptyHtml = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { background: #d8d8d4; padding: 24px; font-family: "Courier New", monospace; }
  .receipt { width: 460px; margin: 0 auto; background: #fdfdf8; padding: 26px 22px; font-size: 16px; text-align: center; }
</style></head><body><div class="receipt">CORNER STORE<br>— no items printed —</div></body></html>`;

type Extraction = {
  lines: { description: string; unitCount: number; lineTotalCents: number; confidence: number | null }[];
  receiptTotalCents: number | null;
  retailer: string | null;
  purchasedAt: string | null;
};

const RECEIPTS: { jpegName: string; html: string; extraction: Extraction }[] = [
  {
    jpegName: 'receipt-costco.jpg',
    html,
    extraction: {
      lines: LINES.map((l) => ({
        description: l.description,
        unitCount: l.unitCount,
        lineTotalCents: l.cents,
        confidence: 0.97,
      })),
      receiptTotalCents: TOTAL,
      retailer: 'Costco',
      purchasedAt: PURCHASED_AT,
    },
  },
  {
    jpegName: 'receipt-edge.jpg',
    html: edgeHtml,
    extraction: {
      lines: EDGE_LINES,
      receiptTotalCents: null,
      retailer: 'Edge Mart',
      purchasedAt: null,
    },
  },
  {
    jpegName: 'receipt-empty.jpg',
    html: emptyHtml,
    extraction: { lines: [], receiptTotalCents: null, retailer: null, purchasedAt: null },
  },
];

async function main() {
  const root = process.cwd();
  const fixturesDir = path.join(root, 'src/server/extraction-fixtures');

  await fs.mkdir(fixturesDir, { recursive: true });
  // Drop stale fixture JSONs from previous generations of these receipts.
  for (const f of await fs.readdir(fixturesDir)) {
    if (f.endsWith('.json')) await fs.unlink(path.join(fixturesDir, f));
  }

  const browser = await chromium.launch();
  for (const receipt of RECEIPTS) {
    const page = await browser.newPage({
      viewport: { width: 560, height: 900 },
      deviceScaleFactor: 2,
    });
    await page.setContent(receipt.html);
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 82, fullPage: true });
    await page.close();

    const jpegPath = path.join(root, 'e2e/fixtures', receipt.jpegName);
    await fs.writeFile(jpegPath, jpeg);
    const sha = createHash('sha256').update(jpeg).digest('hex');
    await fs.writeFile(
      path.join(fixturesDir, `${sha}.json`),
      JSON.stringify(receipt.extraction, null, 2) + '\n',
    );

    console.log(`wrote ${jpegPath} (${jpeg.length} bytes)`);
    console.log(`wrote src/server/extraction-fixtures/${sha}.json`);
  }
  await browser.close();
}

main();
