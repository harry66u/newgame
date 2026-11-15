#!/usr/bin/env node
/* Tile several PNGs into one contact sheet, so a set of views or a motion strip can be looked at as
   a single image.

   node tools/sheet.mjs --out sheet.png [--cols 3] [--tile 640] a.png b.png c.png ...

   --cols <n>    tiles per row (default 3)         --tile <px>   width of each tile (default 640)
   Also used by tools/shot.mjs --sheet. */
import { createRequire } from 'node:module';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);

/* images: file paths or PNG buffers. browser: an open Playwright browser to reuse (optional). */
export async function sheet(images, out, cols = 3, tile = 640, browser = null) {
  let own = null;
  if (!browser) {
    let chromium;
    try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/node-tools/node_modules/playwright')); }
    own = browser = await chromium.launch();
  }
  const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
  const tags = images.map((im) => `<img src="data:image/png;base64,${(Buffer.isBuffer(im) ? im : fs.readFileSync(im)).toString('base64')}">`).join('');
  await page.setContent(`<body style="margin:0;background:#101624"><div id="g" style="display:grid;grid-template-columns:repeat(${Math.min(cols, images.length)},${tile}px);gap:4px;width:max-content">${tags}</div><style>img{width:${tile}px;height:auto;display:block}</style></body>`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete && i.naturalWidth > 0));
  await page.locator('#g').screenshot({ path: out });
  await page.close();
  if (own) await own.close();
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const a = process.argv.slice(2), files = [], opt = {};
  for (let i = 0; i < a.length; i++) { if (a[i].startsWith('--')) opt[a[i].slice(2)] = a[++i]; else files.push(a[i]); }
  if (!opt.out || !files.length) { console.error('usage: node tools/sheet.mjs --out sheet.png [--cols 3] [--tile 640] a.png b.png ...'); process.exit(2); }
  await sheet(files, opt.out, +(opt.cols || 3), +(opt.tile || 640));
  console.log(opt.out, files.length + ' tiles');
}
