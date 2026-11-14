#!/usr/bin/env node
/* Fall Line: single-file build.   node tools/build.mjs [--check]

   Reads index.html as it is now and writes two files into dist/:

     dist/fall-line.html   the whole game as one HTML document. Every <script src> is inlined in
                           order, local stylesheets are inlined, and every url(...) in the CSS
                           (the fonts) becomes a base64 data: URI. It runs by double-clicking it.
     dist/artifact.html    the same game as a fragment for a host page that supplies its own
                           doctype, <html>, <head> and <body>: title, one meta, the styles, a tiny
                           script that copies index.html's <body> attributes onto document.body,
                           then the body markup and scripts.

   --check then loads both in headless Chromium (Playwright) and exits 1 unless each one starts,
   makes no network requests, logs no errors, begins a run on FL.game.press() and has no dead
   renderer layer.

   Node 20+, no dependencies. Playwright is only needed for --check. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'index.html');
const DIST = path.join(ROOT, 'dist');
const TITLE = 'Fall Line';

const MIME = {
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

class BuildError extends Error {}
const fail = (msg) => { throw new BuildError(msg); };

const isRemote = (ref) => /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref);
const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');

// A reference found in index.html or in a stylesheet, resolved to a file inside the repo.
function resolveRef(ref, baseDir, usedBy) {
  let clean = ref.replace(/[?#].*$/, '');
  try { clean = decodeURIComponent(clean); } catch (e) { /* keep it as written */ }
  const file = path.resolve(baseDir, clean.replace(/^\/+/, ''));
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) fail(`${usedBy} refers to "${ref}", which is outside the project`);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`${usedBy} refers to "${ref}", but ${rel(file)} does not exist`);
  return file;
}

const stats = { scripts: 0, sheets: 0, assets: 0, assetBytes: 0 };
const dataUris = new Map();

function dataUri(file) {
  let uri = dataUris.get(file);
  if (!uri) {
    const mime = MIME[path.extname(file).toLowerCase()] || fail(`do not know the content type of ${rel(file)}; add it to MIME in tools/build.mjs`);
    const buf = fs.readFileSync(file);
    uri = `data:${mime};base64,${buf.toString('base64')}`;
    dataUris.set(file, uri);
    stats.assets++; stats.assetBytes += buf.length;
  }
  return uri;
}

// url(...) in CSS -> data: URI. Remote, data: and fragment-only references are left alone.
function embedCss(css, baseDir, usedBy) {
  return css.replace(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^'")\s]+))\s*\)/gi, (m, a, b, c) => {
    const ref = (a ?? b ?? c).trim();
    if (!ref || isRemote(ref)) return m;
    return `url("${dataUri(resolveRef(ref, baseDir, usedBy))}")`;
  });
}

// JavaScript and CSS go inside <script> and <style>, where the only thing that can end the element
// early is its own closing tag (and, in scripts, an HTML comment opener can swallow one).
const safeJs = (js) => js.replace(/<\/(script)/gi, '<\\/$1').replace(/<!--/g, '<\\!--');
const safeCss = (css) => css.replace(/<\/(style)/gi, '<\\/$1');

const attr = (tag, name) => {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
};

// Inline everything a piece of index.html points at.
function inline(html) {
  // <style> blocks: embed their url(...)s
  html = html.replace(/(<style\b[^>]*>)([\s\S]*?)(<\/style\s*>)/gi, (m, open, css, close) => open + embedCss(css, ROOT, 'index.html') + close);
  // <link rel="stylesheet" href="local.css">
  html = html.replace(/<link\b[^>]*>/gi, (tag) => {
    const href = attr(tag, 'href');
    if (!/\bstylesheet\b/i.test(attr(tag, 'rel') || '') || !href || isRemote(href)) return tag;
    const file = resolveRef(href, ROOT, 'index.html');
    stats.sheets++;
    return `<style>\n/* ${rel(file)} */\n${safeCss(embedCss(fs.readFileSync(file, 'utf8'), path.dirname(file), rel(file)))}\n</style>`;
  });
  // <script src="local.js"></script>, in document order
  html = html.replace(/<script\b([^>]*)>\s*<\/script\s*>/gi, (m, attrs) => {
    const src = attr(attrs, 'src');
    if (!src || isRemote(src)) return m;
    const file = resolveRef(src, ROOT, 'index.html');
    const keep = attrs.replace(/\s*\bsrc\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+)/i, '').replace(/\s*\b(?:defer|async)\b(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'>]+))?/gi, '').trim();
    stats.scripts++;
    return `<script${keep ? ' ' + keep : ''}>\n/* ${rel(file)} */\n${safeJs(fs.readFileSync(file, 'utf8'))}\n</script>`;
  });
  return html;
}

function parseAttrs(s) {
  const out = {};
  const re = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(s))) out[m[1]] = m[2] ?? m[3] ?? m[4] ?? '';
  return out;
}

// The host's <body> will not carry index.html's body attributes, and the CSS and scripts rely on them.
function bodyAttrScript(attrs) {
  if (!Object.keys(attrs).length) return '';
  const json = JSON.stringify(attrs).replace(/</g, '\\u003c');
  return '<script>(function(b,a){for(var k in a){if(k==="class"){if(a[k].trim())b.classList.add.apply(b.classList,a[k].trim().split(/\\s+/));}'
    + 'else if(k==="style")b.style.cssText+=";"+a[k];else b.setAttribute(k,a[k]);}})(document.body,' + json + ');</script>\n';
}

function build() {
  if (!fs.existsSync(SRC)) fail('index.html not found next to tools/');
  const src = fs.readFileSync(SRC, 'utf8');

  const body = /<body\b([^>]*)>([\s\S]*)<\/body\s*>/i.exec(src) || fail('index.html has no <body>…</body>');
  const head = /<head\b[^>]*>([\s\S]*?)<\/head\s*>/i.exec(src) || fail('index.html has no <head>…</head>');
  const bodyAttrs = parseAttrs(body[1]);

  // 1. the stand-alone document: index.html with everything inlined
  const single = inline(src);
  const scriptsInlined = stats.scripts;
  if (!scriptsInlined) fail('index.html has no <script src="…"> to inline; is it mid-edit?');

  // 2. the fragment: head styles, then the body's own content
  const headBlocks = [];
  inline(head[1]).replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, (m) => { headBlocks.push(m); return m; });
  // scripts in the head (there are none today) must still run, after the styles
  head[1].replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, (m) => { headBlocks.push(inline(m)); return m; });
  const fragment = `<title>${TITLE}</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n`
    + headBlocks.join('\n') + '\n'
    + bodyAttrScript(bodyAttrs)
    + inline(body[2]).trim() + '\n';
  if (/<\/?(?:html|head|body)\b|<!doctype/i.test(fragment.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, ''))) {
    fail('the fragment still contains a doctype, <html>, <head> or <body> tag');
  }

  for (const [name, text] of [['fall-line.html', single], ['artifact.html', fragment]]) {
    const left = /<script\b[^>]*\bsrc\s*=\s*["']?(?!["']?(?:[a-z][a-z0-9+.-]*:|\/\/))[^>]*>/i.exec(text);
    if (left) fail(`${name} still loads a local script: ${left[0]}`);
  }

  fs.mkdirSync(DIST, { recursive: true });
  const out = { single: path.join(DIST, 'fall-line.html'), fragment: path.join(DIST, 'artifact.html') };
  fs.writeFileSync(out.single, single);
  fs.writeFileSync(out.fragment, fragment);

  const kb = (n) => (n / 1024).toFixed(1) + ' kB';
  console.log(`inlined ${scriptsInlined} scripts${stats.sheets ? ', ' + stats.sheets + ' stylesheets' : ''} and ${dataUris.size} embedded assets (${kb([...dataUris.keys()].reduce((n, f) => n + fs.statSync(f).size, 0))} before base64)`);
  for (const f of [out.single, out.fragment]) console.log(`${rel(f).padEnd(22)} ${kb(fs.statSync(f).size).padStart(10)}  (${fs.statSync(f).size} bytes)`);
  return { out, fragment, bodyAttrs };
}

/* ---- --check: play both outputs in headless Chromium ---- */

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const id of ['playwright', '/opt/node-tools/node_modules/playwright']) {
    try { return require(id); } catch (e) { /* try the next place */ }
  }
  fail('--check needs Playwright (npm i -g playwright, or have it at /opt/node-tools/node_modules/playwright)');
}

async function checkPage(browser, label, file, bodyAttrs) {
  const problems = [];
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const url = pathToFileURL(file).href;
  page.on('console', (m) => { if (m.type() === 'error') problems.push('console error: ' + m.text()); });
  page.on('pageerror', (e) => problems.push('uncaught error: ' + (e && e.message ? e.message : e)));
  page.on('requestfailed', (r) => problems.push(`failed request: ${r.url().slice(0, 120)} (${r.failure() ? r.failure().errorText : 'unknown'})`));
  page.on('request', (r) => { const u = r.url(); if (u !== url && !u.startsWith('data:') && !u.startsWith('blob:')) problems.push('not self-contained, it requested ' + u.slice(0, 120)); });
  try {
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(() => !!(window.FL && window.FL.game), null, { timeout: 15000 })
      .catch(() => problems.push('window.FL.game never appeared'));
    if (!problems.length) {
      const missing = await page.evaluate((names) => names.filter((n) => !document.body.hasAttribute(n)), Object.keys(bodyAttrs));
      if (missing.length) problems.push('document.body is missing attributes from index.html: ' + missing.join(', '));
      await page.waitForTimeout(400);                       // a few frames on the title screen
      await page.evaluate(() => { window.FL.game.press(); });
      await page.waitForFunction(() => window.FL.game.mode === 'run', null, { timeout: 5000 })
        .catch(async () => problems.push(`FL.game.press() did not start a run (mode is "${await page.evaluate(() => window.FL.game.mode).catch(() => '?')}")`));
      await page.waitForTimeout(1200);                      // let every layer draw some of the run
      const r = await page.evaluate(() => {
        const g = window.FL.game, ls = g.R && g.R.layers;
        if (!ls) return { layers: -1, dead: [] };
        const list = Array.isArray(ls) ? ls : Object.keys(ls).map((k) => Object.assign({ name: k }, ls[k]));
        return { layers: list.length, dead: list.filter((l) => l && l.dead === true).map((l) => l.name || '?'), fonts: document.fonts ? [...document.fonts].filter((f) => f.status === 'loaded').length : -1 };
      });
      if (r.layers < 0) problems.push('FL.game.R.layers is missing');
      else if (!r.layers) problems.push('FL.game.R.layers is empty');
      if (r.dead.length) problems.push('dead renderer layers: ' + r.dead.join(', '));
      if (r.fonts === 0) problems.push('none of the embedded fonts loaded');
      if (!problems.length) console.log(`ok    ${label}: run started, ${r.layers} layers alive, ${r.fonts} fonts loaded, no errors, no requests`);
    }
  } catch (e) {
    problems.push('could not load: ' + e.message);
  }
  await page.close();
  for (const p of [...new Set(problems)]) console.error(`FAIL  ${label}: ${p}`);
  return problems.length === 0;
}

async function check({ out, fragment, bodyAttrs }) {
  if (!fragment.startsWith(`<title>${TITLE}</title>\n<meta name="claude:viewport-fit-sides" content="cover">\n<style`)) {
    fail('artifact.html does not begin with the title, the viewport-fit meta and a <style> block');
  }
  const { chromium } = loadPlaywright();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fall-line-check-'));
  const host = path.join(tmp, 'host.html');
  fs.writeFileSync(host, "<!doctype html><html><head><meta charset=utf-8><meta name=viewport content='width=device-width, initial-scale=1, viewport-fit=cover'></head><body>" + fragment + '</body></html>');
  const browser = await chromium.launch({ args: ['--enable-unsafe-swiftshader'] });
  let ok = true;
  try {
    ok = await checkPage(browser, 'dist/fall-line.html', out.single, bodyAttrs) && ok;
    ok = await checkPage(browser, 'dist/artifact.html in a host page', host, bodyAttrs) && ok;
  } finally {
    await browser.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return ok;
}

try {
  const built = build();
  if (process.argv.includes('--check')) {
    const ok = await check(built);
    console.log(ok ? 'check passed' : 'check FAILED');
    process.exit(ok ? 0 : 1);
  }
} catch (e) {
  if (e instanceof BuildError) { console.error('build failed: ' + e.message); process.exit(1); }
  throw e;
}
