// tools/build-index.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildIndex, appNormalize } from './build-index.mjs';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..');

test('buildIndex groups by manufacturer dir and digests devices', () => {
  const idx = buildIndex(repoRoot);
  assert.equal(idx.index_schema, 1);
  const anker = idx.manufacturers.find(m => m.slug === 'anker-soundcore');
  assert.ok(anker, 'anker-soundcore group present');
  assert.equal(anker.name, 'Anker / Soundcore');
  const sop = anker.devices.find(d => d.id === 'soundcore-space-one-pro');
  assert.ok(sop, 'space one pro present');
  assert.equal(sop.schema_version, 3);
  // The index must carry through whatever the manifest declares. Pinning a literal here meant
  // every legitimate revision bump broke CI — it did, when the generic 66666666-… UUID was
  // dropped from this manifest's match rule (rev 3, 2026-09-17). Compare against the manifest
  // on disk instead, and keep a floor so an accidental reset is still caught.
  const sopManifest = JSON.parse(readFileSync(
    join(repoRoot, 'manifests/anker-soundcore/soundcore-space-one-pro.json'), 'utf8'));
  assert.equal(sop.revision, sopManifest.revision);
  assert.ok(sop.revision >= 3, 'revision must not go backwards');
  assert.deepEqual(sop.transports, ['rfcomm']);
  assert.deepEqual(sop.platforms, ['pixelos']);
  assert.match(sop.sha256, /^[0-9a-f]{64}$/);
  assert.equal(sop.url, 'manifests/anker-soundcore/soundcore-space-one-pro.json');
  assert.ok(sop.match.name_regex, 'match block copied');
});

test('buildIndex rejects an invalid manifest', () => {
  assert.throws(() => buildIndex(repoRoot, { extra: [{ schema_version: 2, id: 'bad' }] }),
    /schema|valid/i);
});

test('appNormalize matches the app httpGet line-buffered reader', () => {
  // canonical form (LF + single trailing newline) is a fixed point
  assert.equal(appNormalize('{"a":1}\n'), '{"a":1}\n');
  // a trailing CRLF is normalized to LF
  assert.equal(appNormalize('{"a":1}\r\n'), '{"a":1}\n');
  // an interior CRLF is normalized to LF
  assert.equal(appNormalize('{\r\n"a":1}\r\n'), '{\n"a":1}\n');
  // a missing trailing newline is added (the reader emits one per line)
  assert.equal(appNormalize('{"a":1}'), '{"a":1}\n');
  // appNormalize is idempotent (so the guard's `raw === appNormalize(raw)`
  // accepts exactly the strings the app reader reproduces verbatim, e.g. a
  // file already ending in two newlines is preserved by both sides)
  assert.equal(appNormalize(appNormalize('{"a":1}\n\n')), appNormalize('{"a":1}\n\n'));
});

test('every committed manifest is already in the app canonical byte form', () => {
  // buildIndex throws via assertAppByteParity if any manifest is not LF + single
  // trailing newline — so a clean run proves on-device OTA sha256 will match.
  assert.doesNotThrow(() => buildIndex(repoRoot));
});
