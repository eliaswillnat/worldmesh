// Builds the runtime worldmesh.net serves for loadWorldMesh (src/load.ts):
// src/hosted.ts with everything it needs bundled in, except Three.js, which
// it takes from the world that loads it. Run after `npm run build:runtime`.
//
//   node packages/runtime/scripts/build-hosted.mjs <dir>
//
// writes <dir>/<protocol>/index.js (loadWorldMesh asks for a new ?v= every 5 minutes)
// and <dir>/<protocol>/c/*.js (content-hashed chunks, cached for good);
// apps/hub/public/_headers sets both. See docs/publishing.md.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const target = process.argv[2];
if (!target) {
  console.error('build-hosted: usage: node build-hosted.mjs <output dir>');
  process.exit(1);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const version = readFileSync(resolve(root, 'src/version.ts'), 'utf8');
const protocol = version.match(/WORLDMESH_PROTOCOL = (\d+)/)?.[1];
if (!protocol) {
  console.error('build-hosted: could not find WORLDMESH_PROTOCOL in src/version.ts');
  process.exit(1);
}
const outDir = resolve(process.cwd(), target, protocol);

// `three` becomes the world's own copy, which loadWorldMesh leaves here.
// Every name it exports is listed, and the build keeps the ones used.
const THREE_ID = '\0worldmesh-three';
const names = Object.keys(await import('three')).filter((name) => /^[A-Za-z_$][\w$]*$/.test(name));
const threeModule = [
  "const THREE = globalThis[Symbol.for('worldmesh.three')];",
  "if (!THREE) throw new Error('[WorldMesh] Load this runtime with loadWorldMesh from @worldmesh/runtime, which hands it the world\\'s Three.js.');",
  ...names.map((name) => `export const ${name} = THREE.${name};`),
].join('\n');

await build({
  configFile: false,
  root,
  logLevel: 'warn',
  plugins: [
    {
      name: 'worldmesh-three',
      enforce: 'pre',
      resolveId: (id) => (id === 'three' ? THREE_ID : null),
      load: (id) => (id === THREE_ID ? threeModule : null),
    },
  ],
  // three-vrm reads it; there is no bundler on the world's side to set it.
  define: { 'process.env.NODE_ENV': '"production"' },
  build: {
    outDir,
    emptyOutDir: true,
    target: 'es2022',
    minify: true,
    sourcemap: true,
    copyPublicDir: false,
    lib: {
      entry: resolve(root, 'dist/hosted.js'),
      formats: ['es'],
      fileName: () => 'index.js',
    },
    rolldownOptions: {
      treeshake: { propertyReadSideEffects: false },
      // Library builds keep whitespace by default; nobody imports this one but loadWorldMesh.
      output: { chunkFileNames: 'c/[name]-[hash].js', minify: true },
    },
  },
});

console.log(`build-hosted: runtime for protocol ${protocol} in ${outDir}`);
