/**
 * One real extraction against the Anthropic API through the actual
 * ExtractionService code path, using the committed realistic receipt fixture.
 * NOT part of the e2e suite (fixture mode is the tested path) — run by hand
 * when validating live mode or a model bump:
 *
 *   ANTHROPIC_API_KEY=… npx tsx scripts/extract-live-smoke.ts
 */
import fs from 'node:fs/promises';
import path from 'node:path';

process.env.EXTRACTION_MODE = 'live';

async function main() {
  const { extractReceipt } = await import('../src/server/extraction');
  const jpeg = await fs.readFile(path.join(process.cwd(), 'e2e/fixtures/receipt-costco.jpg'));

  const startedAt = Date.now();
  const result = await extractReceipt([{ jpeg, originalSha256: null }]);
  const ms = Date.now() - startedAt;

  if (result.status !== 'ok') {
    console.error(`UNAVAILABLE after ${ms}ms: ${result.reason}`);
    process.exit(1);
  }

  console.log(`model=${result.model} latency=${ms}ms`);
  console.log(`retailer=${result.data.retailer} purchasedAt=${result.data.purchasedAt}`);
  console.log(`receiptTotalCents=${result.data.receiptTotalCents}`);
  for (const line of result.data.lines) {
    console.log(
      `  ${line.description} · ${line.unitCount}u · ${line.lineTotalCents}c · conf=${line.confidence}`,
    );
  }

  // Compare against the committed fixture (the image's ground truth).
  const fixturesDir = path.join(process.cwd(), 'src/server/extraction-fixtures');
  const [fixtureFile] = (await fs.readdir(fixturesDir)).filter((f) => f.endsWith('.json'));
  const expected = JSON.parse(await fs.readFile(path.join(fixturesDir, fixtureFile), 'utf8'));
  const got = new Map(
    result.data.lines.map((l) => [l.description.toUpperCase(), l] as const),
  );
  let matches = 0;
  for (const line of expected.lines) {
    const hit = got.get(line.description.toUpperCase());
    const ok =
      hit && hit.unitCount === line.unitCount && hit.lineTotalCents === line.lineTotalCents;
    if (ok) matches++;
    else console.log(`  MISMATCH: ${line.description} → ${hit ? JSON.stringify(hit) : 'missing'}`);
  }
  console.log(
    `${matches}/${expected.lines.length} lines match the ground truth exactly; ` +
      `total ${result.data.receiptTotalCents === expected.receiptTotalCents ? 'matches' : 'DIFFERS'}`,
  );
}

main();
