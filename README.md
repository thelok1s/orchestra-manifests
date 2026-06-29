# orchestra-manifests

Device manifest registry for [Orchestra](https://github.com/thelok1s/orchestra) — an
LSPosed module + app that adds native Soundcore (Anker) headphone controls to Pixel /
Android 16 system UI.

---

## What this repo is

Orchestra drives its device support from per-device JSON manifests. Each manifest tells the
app:

- how to **recognise** a Bluetooth device (name regex, SDP UUIDs),
- which **transport/protocol channel** to open (RFCOMM UUID, framing),
- every **capability** the device exposes and how to map it to a native Android preference,
- which **ROM injection bindings** to use when hooking system UI.

This repo is the canonical source for those manifests. The app fetches them at runtime and
caches them locally; manifests are never bundled inside the APK (except a seed copy for
first-boot).

---

## Repo layout

```
manifests/
  <manufacturer-slug>/
    <device-id>.json        # one file per device
index.json                  # generated — do not edit by hand
schema/
  manifest.schema.json      # JSON Schema for a single manifest
  index.schema.json         # JSON Schema for index.json
  SCHEMA.md                 # human-readable schema reference
tools/
  build-index.mjs           # generates / validates index.json
```

Manufacturer slugs are lower-kebab-case (e.g. `anker-soundcore`). Device IDs are stable
kebab-case slugs that also serve as the filename stem.

---

## How the app consumes manifests

The app resolves manifests via the `raw.githubusercontent.com` base URL:

```
https://raw.githubusercontent.com/thelok1s/orchestra-manifests/main/
```

On startup the app checks its local cache TTL; if stale it fetches `index.json` from the
above URL to discover available devices, then lazily fetches individual manifests by their
`url` path as needed.

The app ships a **seed** copy of `index.json` and the currently supported manifests so it
works offline on first boot. The seed is replaced on the first successful network refresh.

---

## Authoring a device manifest

### Quick start

1. Copy an existing manifest as your starting point:
   ```bash
   cp manifests/anker-soundcore/soundcore-space-one-pro.json \
      manifests/anker-soundcore/soundcore-my-new-device.json
   ```
2. Set a new stable `id` (kebab-case, matches the filename stem).
3. Set `revision: 1` and `revision_date` to today's ISO date (`YYYY-MM-DD`).
4. Mark every `function` with `"_verified": false` until you confirm the command bytes on
   real hardware. The app respects `_verified` when surfacing confidence warnings.
5. Regenerate the index:
   ```bash
   npm run build-index
   ```
6. Commit **both** your new manifest and the regenerated `index.json`:
   ```bash
   git add manifests/anker-soundcore/soundcore-my-new-device.json index.json
   git commit -m "manifests: add Soundcore My New Device (unverified)"
   ```

### Revision discipline

Bump `revision` (and update `revision_date`) on **every** content edit — including flipping
`_verified`, correcting a byte value, or changing `inject_reason`. The app uses `revision`
to detect whether a cached manifest is stale.

### Field reference

See [`schema/SCHEMA.md`](schema/SCHEMA.md) for a complete description of every field,
including the `channels` map, `platforms` block, injectability rules, and graceful-degrade
behaviour.

---

## CI freshness gate

GitHub Actions runs on every push and pull request:

1. `npm test` — validates all manifests against `schema/manifest.schema.json` and
   `index.json` against `schema/index.schema.json`.
2. `npm run check` — regenerates `index.json` in-memory and diffs it against the committed
   copy. **If `index.json` is stale the check fails.** Always regenerate and commit
   `index.json` alongside any manifest change.

---

## Sideload for testing

The Orchestra app supports loading a manifest directly from the device filesystem. A
sideloaded manifest takes the highest precedence — it overrides any cloud or seed entry with
the same `id`. This lets you iterate on command bytes locally without publishing to the repo.

See the in-app developer settings for the sideload path.

---

## License

GPL-3.0-or-later. See [LICENSE](LICENSE).

This project builds on reverse-engineering work from
[OpenSCQ30](https://github.com/Oppzippy/OpenSCQ30) and the broader LSPosed ecosystem, both
of which are GPL-3.0.
