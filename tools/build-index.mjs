import { readFileSync, readdirSync, writeFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

function loadSchema(repoRoot) {
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  const schema = JSON.parse(readFileSync(join(repoRoot, 'schema/manifest.schema.json'), 'utf8'));
  return ajv.compile(schema);
}

function listManifestFiles(repoRoot) {
  const base = join(repoRoot, 'manifests');
  const out = [];
  for (const slug of readdirSync(base)) {
    const dir = join(base, slug);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir)) {
      if (f.endsWith('.json')) out.push({ slug, path: join(dir, f) });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

// The Orchestra app downloads a manifest via a line-buffered HTTP reader that
// normalizes every line terminator to '\n' and guarantees exactly one trailing
// '\n', then sha256s that text and compares it to the index's sha256 (which we
// compute over the raw file bytes here). For those two hashes to match for ALL
// manifests, every committed manifest must ALREADY be in that normalized form:
// LF line endings, exactly one trailing newline. This guard enforces it at
// index-build time so a CRLF or missing/extra trailing newline can never cause
// a silent OTA sha256 rejection on-device. Mirrors ManifestRepository.httpGet.
export function appNormalize(raw) {
  const lines = raw.split('\n').map(l => l.replace(/\r$/, ''));
  if (lines[lines.length - 1] === '') lines.pop(); // a file's trailing \n yields no final readLine
  return lines.join('\n') + '\n';
}

function assertAppByteParity(raw, path) {
  if (raw !== appNormalize(raw)) {
    throw new Error(`Manifest ${path} is not in the app's canonical byte form ` +
      `(must use LF line endings and end with exactly one trailing newline). ` +
      `Re-save it with LF + a single trailing newline; otherwise on-device OTA ` +
      `downloads will fail the sha256 check.`);
  }
}

function countFunctions(m) {
  const fns = Array.isArray(m.functions) ? m.functions : [];
  let injectable = 0, verified = 0;
  for (const f of fns) {
    if (f._verified) verified++;
    if (f.type === 'multitoggle' || f.type === 'toggle') injectable++;
  }
  return { capabilities: fns.length, injectable, verified };
}

export function buildIndex(repoRoot, opts = {}) {
  const validate = loadSchema(repoRoot);
  const bySlug = new Map();
  const files = listManifestFiles(repoRoot);
  for (const { slug, path } of files) {
    const raw = readFileSync(path, 'utf8');
    assertAppByteParity(raw, path);
    const m = JSON.parse(raw);
    if (!validate(m)) {
      throw new Error(`Manifest ${path} is not valid v3:\n` +
        validate.errors.map(e => `  ${e.instancePath} ${e.message}`).join('\n'));
    }
    const sha256 = createHash('sha256').update(raw).digest('hex');
    const entry = {
      id: m.id,
      name: m.name,
      schema_version: m.schema_version,
      revision: m.revision,
      name_regex: m.match?.name_regex ?? null,
      match: m.match,
      transports: [...new Set(Object.values(m.channels).map(c => c.transport))],
      platforms: m.platforms ? Object.keys(m.platforms) : [],
      counts: countFunctions(m),
      url: relative(repoRoot, path).split('\\').join('/'),
      sha256,
    };
    if (!bySlug.has(slug)) bySlug.set(slug, { slug, name: m.manufacturer, devices: [] });
    bySlug.get(slug).devices.push(entry);
  }
  // test hook: validate injected extras too (used to assert rejection)
  for (const extra of opts.extra ?? []) {
    if (!validate(extra)) throw new Error('extra manifest invalid per schema');
  }
  return {
    index_schema: 1,
    generated: opts.now ?? new Date().toISOString(),
    repo: 'orchestra-manifests',
    manufacturers: [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
  };
}

function stableStringify(idx) {
  // generated timestamp excluded from the --check comparison
  const { generated, ...rest } = idx;
  return JSON.stringify(rest, null, 2);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const repoRoot = join(fileURLToPath(import.meta.url), '..', '..');
  const check = process.argv.includes('--check');
  const fresh = buildIndex(repoRoot);
  const outPath = join(repoRoot, 'index.json');
  if (check) {
    let current;
    try { current = JSON.parse(readFileSync(outPath, 'utf8')); }
    catch { console.error('index.json missing or unparseable'); process.exit(1); }
    if (stableStringify(current) !== stableStringify(fresh)) {
      console.error('index.json is STALE — run `npm run build-index` and commit.');
      process.exit(1);
    }
    console.log('index.json is up to date.');
  } else {
    writeFileSync(outPath, JSON.stringify(fresh, null, 2) + '\n');
    console.log(`Wrote ${outPath} (${fresh.manufacturers.length} manufacturer group(s)).`);
  }
}
