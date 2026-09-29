// WORLDMESH_VERSION is part of the public API, so it must not drift from the
// version npm publishes. Run before every build; see docs/publishing.md.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const pkg = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
const index = readFileSync(new URL('src/index.ts', root), 'utf8');

const version = index.match(/WORLDMESH_VERSION = '([^']+)'/)?.[1];
const protocol = index.match(/WORLDMESH_PROTOCOL = (\d+)/)?.[1];

const fail = (message) => {
  console.error(`check-version: ${message}`);
  console.error(`  ${fileURLToPath(new URL('src/index.ts', root))}`);
  process.exit(1);
};

if (!version) fail('could not find WORLDMESH_VERSION in src/index.ts');
if (!protocol) fail('could not find WORLDMESH_PROTOCOL in src/index.ts');
if (version !== pkg.version) {
  fail(`WORLDMESH_VERSION is ${version} but package.json version is ${pkg.version}`);
}

console.log(`check-version: ${pkg.name} ${version}, protocol ${protocol}`);
