// 使い方: node render.mjs <開始フレーム> <終了フレーム(含まない)> [出力ディレクトリ]
// 単発確認: node render.mjs --still 12.5 out.png
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const FPS = 30;
const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);

const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--enable-webgl'] });
const page = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
page.on('pageerror', e => { console.error('pageerror', e); process.exit(1); });
await page.goto(pathToFileURL(path.join(here, 'index.html')).href);
await page.evaluate(() => window.ready);

if (args[0] === '--still') {
  for (let i = 1; i + 1 < args.length; i += 2) {
    await page.evaluate(t => window.renderFrame(t), parseFloat(args[i]));
    await page.screenshot({ path: args[i + 1] });
  }
} else {
  const [a, b] = [parseInt(args[0]), parseInt(args[1])];
  const out = args[2] || path.join(here, 'frames');
  fs.mkdirSync(out, { recursive: true });
  for (let f = a; f < b; f++) {
    await page.evaluate(t => window.renderFrame(t), f / FPS);
    await page.screenshot({ path: path.join(out, String(f).padStart(5, '0') + '.jpg'), type: 'jpeg', quality: 96 });
    if ((f - a) % 50 === 0) console.log(`[${a}-${b}] ${f}`);
  }
}
await browser.close();
