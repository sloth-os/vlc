// Verifies the static contract of index.html: relative URLs only, coi.js
// loaded first, the manifest linked, module app.js, every referenced element
// id present, no external resources. Run: node tests/index-html.test.mjs
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
let passed = 0;
let failed = 0;

function ok(cond, label) {
  if (cond) { passed++; console.log(`  ok - ${label}`); }
  else { failed++; console.log(`  NOT OK - ${label}`); }
}

const html = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

console.log('index.html static contract:');

// coi.js must be the FIRST script in <head>, before any other script or style
// that could start the app: it registers the SW and may reload the page.
const head = html.slice(html.indexOf('<head>'), html.indexOf('</head>'));
const firstScript = head.match(/<script[^>]*src="([^"]*)"[^>]*>/);
ok(!!firstScript, 'a script with src exists in <head>');
ok(firstScript?.[1] === './coi.js', `coi.js is the first head script (got ${firstScript?.[1]})`);

// app.js is a module, loaded from the body
ok(/<script type="module" src="\.\/app\.js"><\/script>/.test(html), 'app.js loaded as type=module');

// manifest + icons linked with relative URLs
ok(/<link rel="manifest" href="\.\/manifest\.webmanifest">/.test(html), 'manifest linked');
ok(/<link rel="icon"[^>]*href="\.\/icons\/icon-32\.png">/.test(html), 'icon linked');

// No external resources: every src/href must start with ./ or be a data: URL.
const urls = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
const external = urls.filter((u) => !u.startsWith('./') && !u.startsWith('data:') && !u.startsWith('#'));
ok(external.length === 0, `all URLs relative (external: ${JSON.stringify(external)})`);

// Every element id app.js looks up must exist. app.js collects them in one
// array literal (for (const id of [ ... ]) dom[id] = $(id);) plus direct
// getElementById('...') calls.
const app = readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const arrayBlock = app.match(/for \(const id of \[([\s\S]*?)\]\) dom\[id\] = \$\(id\);/);
const listIds = arrayBlock
  ? [...arrayBlock[1].matchAll(/'([\w-]+)'/g)].map((m) => m[1])
  : [];
const directIds = [...app.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]);
const wanted = [...new Set([...listIds, ...directIds])];
ok(wanted.length > 20, `found a meaningful id list in app.js (${wanted.length} ids)`);
for (const id of wanted) {
  ok(new RegExp(`id="${id}"`).test(html), `index.html has #${id}`);
}

// noscript banner present
ok(/<noscript>/.test(html), 'noscript banner present');

// The video canvas exists and is a canvas
ok(/<canvas id="video-canvas"/.test(html), 'video canvas present');

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
