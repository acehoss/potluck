/**
 * Rasterize assets/icon.svg into the committed PWA icon PNGs via a headless
 * chromium screenshot (no native image deps — same reasoning as the sharp
 * rejection in blueprint 04 §1). Rerun after editing the SVG:
 *
 *   npx tsx scripts/generate-icons.ts
 *
 * Outputs (committed):
 *   public/icon-192.png            manifest icon
 *   public/icon-512.png            manifest icon
 *   public/icon-512-maskable.png   manifest icon, purpose "maskable" (the SVG
 *                                  keeps its art inside the safe zone, so the
 *                                  same art works full-bleed)
 *   public/apple-touch-icon.png    180×180, iOS home screen
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from '@playwright/test';

const ROOT = path.resolve(import.meta.dirname, '..');

const OUTPUTS: { file: string; size: number }[] = [
  { file: 'public/icon-192.png', size: 192 },
  { file: 'public/icon-512.png', size: 512 },
  { file: 'public/icon-512-maskable.png', size: 512 },
  { file: 'public/apple-touch-icon.png', size: 180 },
];

async function main() {
  const svg = await readFile(path.join(ROOT, 'assets/icon.svg'), 'utf8');
  const browser = await chromium.launch();
  try {
    for (const { file, size } of OUTPUTS) {
      const page = await browser.newPage({ viewport: { width: size, height: size } });
      await page.setContent(
        `<!doctype html><style>*{margin:0;padding:0}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`,
      );
      await page.screenshot({ path: path.join(ROOT, file) });
      await page.close();
      console.log(`wrote ${file} (${size}×${size})`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
