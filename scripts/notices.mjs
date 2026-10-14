// Regenerates THIRD_PARTY_NOTICES.md from what the bundle really contains (esbuild metafile), so it cannot drift.
// Usage: npm run notices   (builds the bundle with a metafile, then writes the file)
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const dir = mkdtempSync(join(tmpdir(), 'olc-notices-'));
const meta = join(dir, 'meta.json');
execFileSync('npx', ['esbuild', 'src/extension.ts', '--bundle', '--platform=node', '--format=cjs', '--external:vscode',
  `--outfile=${join(dir, 'out.js')}`, `--metafile=${meta}`,
  "--banner:js=const __importMetaUrl=require('url').pathToFileURL(__filename).href;", '--define:import.meta.url=__importMetaUrl'], { stdio: 'ignore' });

const roots = new Map();
for (const p of Object.keys(JSON.parse(readFileSync(meta, 'utf8')).inputs)) {
  const m = /(?:^|\/)node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(p);
  if (m) roots.set(m[1], p.slice(0, p.indexOf(`node_modules/${m[1]}`) + `node_modules/${m[1]}`.length));
}

const pkgs = [...roots].sort(([a], [b]) => a.localeCompare(b)).flatMap(([name, root]) => {
  if (!existsSync(join(root, 'package.json'))) return [];
  const j = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const file = readdirSync(root).sort().find(f => /^(license|licence|copying)/i.test(f));
  return [{ name, version: j.version ?? '?', license: j.license ?? '?', text: file ? readFileSync(join(root, file), 'utf8').trim() : '' }];
});

const lucide = readFileSync('media/icon-sources/LICENSE-lucide.txt', 'utf8').trim();
const out = [
  '# Third-party notices', '',
  'Overleaf Comments is MIT licensed (see `LICENSE`). The packaged extension bundles the software below, and its icon is derived from a Lucide icon. Their licenses are reproduced as they require.', '',
  '## Icon: Lucide', '',
  'The extension icon (`media/icon.svg`, `media/icon.png`) is built from the Lucide `message-square` and `leaf` icons (<https://lucide.dev>).', '',
  '```text', lucide, '```', '',
  `## Bundled packages (${pkgs.length})`, '',
  'olcli (`@aloth/olcli`, <https://github.com/aloth/olcli>) and the packages it depends on are bundled into `dist/extension.js`.', '',
  ...pkgs.flatMap(p => [`### ${p.name} ${p.version} — ${p.license}`, '', ...(p.text ? ['```text', p.text, '```'] : [`(No license file is shipped by this package; its package.json declares \`${p.license}\`.)`]), '']),
];
writeFileSync('THIRD_PARTY_NOTICES.md', out.join('\n'));
console.log(`THIRD_PARTY_NOTICES.md: ${pkgs.length} packages`);
