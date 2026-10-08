// Door views for the preview worlds, taken during a preview deploy.
//
// workers/screenshot takes door views in Cloudflare's browser, which can't get
// past the Cloudflare Access login in front of preview-*.worldmesh.net. So the
// deploy takes them itself: it serves each freshly built world from disk, opens
// it with ?worldmesh-capture=1 in headless Chrome and calls the same
// __worldmeshCaptureDoorView() the worker does. scripts/preview.sh uploads the
// result to the preview bucket in the worker's own layout.
//
//   node capture.mjs <out-dir> <name>=<dist-dir> [<name>=<dist-dir> ...]
//
// Writes <out-dir>/<name>/{color.webp,depth.png,meta.json} for each world that
// worked. A world that fails is reported and skipped; the exit code stays 0.
// Chrome: CHROME_PATH, else the installed Google Chrome.

import { createReadStream, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve } from 'node:path';
import { chromium } from 'playwright-core';

// Same as workers/screenshot/src/doorViews.ts.
const CAPTURE_PARAM = 'worldmesh-capture';
const LOAD_TIMEOUT = 30_000;
const RUNTIME_TIMEOUT = 30_000;
const SETTLE_TIME = 4_000;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.hdr': 'application/octet-stream',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
};

/** A static server for one dist directory, with index.html for unknown paths. */
function serve(root) {
  const server = createServer((req, res) => {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    let file = normalize(join(root, path));
    if (!file.startsWith(root)) file = join(root, 'index.html');
    if (!existsSync(file) || statSync(file).isDirectory()) {
      const index = join(file, 'index.html');
      file = existsSync(index) ? index : join(root, 'index.html');
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' });
    createReadStream(file).pipe(res);
  });
  return new Promise((done) => server.listen(0, '127.0.0.1', () => done(server)));
}

function decodeDataUrl(dataUrl) {
  return Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64');
}

async function captureOne(browser, name, dist, outDir) {
  const server = await serve(dist);
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  try {
    const { port } = server.address();
    await page.goto(`http://127.0.0.1:${port}/?${CAPTURE_PARAM}=1`, { waitUntil: 'load', timeout: LOAD_TIMEOUT });
    await page.waitForFunction(() => typeof globalThis.__worldmeshCaptureDoorView === 'function', null, {
      timeout: RUNTIME_TIMEOUT,
    });
    await page.waitForTimeout(SETTLE_TIME);
    const view = await page.evaluate(() => globalThis.__worldmeshCaptureDoorView());
    const { color, depth, ...meta } = view;
    const dir = join(outDir, name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'color.webp'), decodeDataUrl(color));
    writeFileSync(join(dir, 'depth.png'), decodeDataUrl(depth));
    writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta));
    console.log(`  ${name}: door view taken`);
  } catch (err) {
    console.log(`  ${name}: no door view (${err?.message?.split('\n')[0] ?? err})`);
  } finally {
    await page.close().catch(() => undefined);
    server.close();
  }
}

const [outArg, ...worlds] = process.argv.slice(2);
if (!outArg || !worlds.length) {
  console.error('usage: node capture.mjs <out-dir> <name>=<dist-dir> ...');
  process.exit(2);
}
const outDir = resolve(outArg);
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' }),
  // WebGL without a GPU, in software, like the capture worker.
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
try {
  for (const world of worlds) {
    const [name, dist] = world.split('=');
    await captureOne(browser, name, resolve(dist), outDir);
  }
} finally {
  await browser.close();
}
