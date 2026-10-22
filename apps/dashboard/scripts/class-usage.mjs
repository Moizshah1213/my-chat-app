// Audits TSX class usage against the CSS rules defined in globals.css.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = 'src';
const files = [];
(function walk(dir) {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p);
    else if (/\.tsx?$/.test(p)) files.push(p);
  }
})(root);

const css = readFileSync(join(root, 'app', 'globals.css'), 'utf8');
const tokens = readFileSync(join(root, 'app', 'tokens.css'), 'utf8');

// CSS class selectors defined anywhere in globals.css
const cssClasses = new Set();
for (const m of css.matchAll(/\.([A-Za-z_][A-Za-z0-9_-]*)/g)) cssClasses.add(m[1]);

// Collect class names used in TSX (literal strings + cn(...) args + template literals)
const used = new Map(); // class -> Set(files)
const add = (cls, file) => {
  cls = cls.trim();
  if (!cls) return;
  // Drop template expressions first: `row ${open ? 'on' : ''}` -> `row ~`
  cls = cls.replace(/\$\{[^}]*\}/g, '~');
  if (!/^[A-Za-z_][A-Za-z0-9_-]*$/.test(cls)) return;
  if (!used.has(cls)) used.set(cls, new Set());
  used.get(cls).add(file);
};
for (const f of files) {
  const src = readFileSync(f, 'utf8');
  for (const m of src.matchAll(/className\s*=\s*"([^"]*)"/g)) m[1].split(/\s+/).forEach((c) => add(c, f));
  for (const m of src.matchAll(/className\s*=\s*'([^']*)'/g)) m[1].split(/\s+/).forEach((c) => add(c, f));
  for (const m of src.matchAll(/className\s*=\s*\{`([^`]*)`\}/g)) m[1].split(/\s+/).forEach((c) => add(c, f));
  for (const m of src.matchAll(/\bcn\(([^)]*)\)/g)) {
    for (const s of m[1].matchAll(/'([^']*)'|"([^"]*)"/g)) (s[1] ?? s[2] ?? '').split(/\s+/).forEach((c) => add(c, f));
  }
}

const missing = [...used.entries()].filter(([c]) => !cssClasses.has(c)).sort();
console.log('=== TSX classes with NO rule in globals.css ===');
if (!missing.length) console.log('  (none)');
for (const [c, where] of missing) console.log(`  .${c}  <- ${[...where].map((f) => relative(root, f)).join(', ')}`);

// Undefined CSS custom properties
const defined = new Set([...tokens.matchAll(/(--[A-Za-z0-9_-]+)\s*:/g)].map((m) => m[1]));
const usedVars = new Map();
for (const m of css.matchAll(/var\(\s*(--[A-Za-z0-9_-]+)/g)) usedVars.set(m[1], (usedVars.get(m[1]) ?? 0) + 1);
console.log('\n=== CSS vars used but NOT defined in tokens.css ===');
const undef = [...usedVars.entries()].filter(([v]) => !defined.has(v)).sort();
if (!undef.length) console.log('  (none)');
for (const [v, n] of undef) console.log(`  ${v}  x${n}`);

console.log(`\nTOTAL tsx classes: ${used.size}, missing: ${missing.length}`);

