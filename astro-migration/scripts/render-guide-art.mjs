// Regenerate social PNGs from the lightweight, on-page SVG illustrations.
// Uses the existing browser-test dependency, not a new image library.
import { chromium } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const names = ['guide-base64-variants', 'guide-kafka-offset-reset', 'guide-kafka-lag', 'guide-access-log-evidence'];
const browser = await chromium.launch({ channel: 'chrome' });
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 }, deviceScaleFactor: 1 });
  for (const name of names) {
    await page.setContent('<style>body{margin:0}svg{display:block}</style>' + await readFile(new URL('../public/og/' + name + '.svg', import.meta.url), 'utf8'));
    await page.screenshot({ path: new URL('../public/og/' + name + '.png', import.meta.url).pathname });
    console.log('Rendered ' + name + '.png');
  }
} finally {
  await browser.close();
}
