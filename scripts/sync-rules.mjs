// Copies the catalog built by the sibling rules repo into rules/pivot-rules.json (gitignored, bundled by Vite).
//   npm run sync-rules            (expects ../MSSentinel-PivotRules/dist/pivot-rules.json, built by `npm run build` there)
//   RULES_DIST=/path/to/pivot-rules.json npm run sync-rules
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = resolve(process.env.RULES_DIST ?? join(root, '..', 'MSSentinel-PivotRules', 'dist', 'pivot-rules.json'));
const dst = join(root, 'rules', 'pivot-rules.json');
if (!existsSync(src)) {
  console.error(`sync-rules: ${src} not found - run "npm run build" in the rules repo first`);
  process.exit(1);
}
const c = JSON.parse(readFileSync(src, 'utf8'));
if (!Array.isArray(c.rules) || !c.indicators || c.formatVersion !== 1) {
  console.error('sync-rules: not a full pivot-rules.json catalog (formatVersion 1 expected)');
  process.exit(1);
}
copyFileSync(src, dst);
const withDefender = c.rules.filter((r) => r.queryDefender).length;
const withTargets = c.rules.filter((r) => r.targets).length;
console.log(`sync-rules: ${c.rules.length} rules (${withDefender} with a Defender variant, ${withTargets} with targets), ` +
  `${(c.scenarios ?? []).length} scenarios, generated ${c.generatedAt} -> rules/pivot-rules.json`);
