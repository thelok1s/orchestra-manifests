# Orchestra device manifest schema (v3–v4)

A device manifest is a JSON file that tells the Orchestra app (a) how to recognise a
Bluetooth device, (b) which transport/protocol channel to open, (c) every capability the
device exposes and how to map it to a native Android preference, and (d) which ROM
injection bindings to use when hooking the system UI. The app reads manifests at runtime
from the cloud index (refreshed on a TTL) and from a local sideload if present.

> **Supported schema_version range: [3, 4].** Manifests outside that range are ignored entirely.

> **v3 vs v2.** v2 used a flat `transport`/`protocol` pair at device level. v3 replaces
> them with a named `channels` map + `default_channel`, so a single manifest can declare
> multiple transport/protocol bundles and individual functions can opt into a specific one.
> v3 also adds a monotonic `revision` counter (bump on **any** content edit), a
> `revision_date`, and an optional `platforms` block for per-ROM injection bindings.

> **v4 vs v3.** v4 introduces the `aacp` transport, driven by the app's `AacpEngine` using
> `protocol.framing: "aap_v1"` (Apple Accessory Protocol over L2CAP). The channel may
> declare a `psm` integer (e.g. `4097` = 0x1001) which is declarative metadata; the
> actual PSM, UUID, and framing constants live inside `AacpEngine`. For `aacp` functions,
> `read` uses a push model: the engine listens for inbound AAP notifications and the
> manifest supplies `notify_opcode` + `value_map` (rather than a polled `command`) to
> map the device-reported byte to an option id. All other v3 fields are unchanged.

---

## Top level

| field | type | req | meaning |
|---|---|---|---|
| `schema_version` | int | yes | `3` or `4`. App gate: only range [3,4] is loaded. |
| `revision` | int | yes | Monotonic counter. Bump on **any** edit, including `_verified` flips. |
| `revision_date` | string | no | ISO 8601 date of the last revision (`YYYY-MM-DD`). |
| `id` | string | yes | Stable kebab-case slug; also the filename stem. |
| `name` | string | yes | Human-readable display name. |
| `manufacturer` | string | yes | Manufacturer display name (e.g. `"Anker / Soundcore"`). |
| `model_code` | string | no | Vendor model code (e.g. `"3062"`). |
| `re_model` | string | no | Matching OpenSCQ30 model code for provenance (may differ from `model_code`). |
| `match` | object | yes | How to recognise the device. See [match](#match). |
| `channels` | object | yes | Named transport+protocol bundles. See [channels](#channels). |
| `default_channel` | string | yes | Key into `channels` used when a function omits `channel`. |
| `platforms` | object | no | Per-ROM injection bindings. See [platforms](#platforms). Absent → app built-in `pixelos` default. |
| `functions[]` | array | yes | Every capability + its UI mapping + injectability. See [functions](#functions). |

---

## match

First matching manifest wins. Every sub-rule that is present must hold:

| field | meaning |
|---|---|
| `name_regex` | Java regex tested against the Bluetooth display name. |
| `service_uuids_any` | Device must advertise at least one of these SDP UUIDs. |
| `model_name_prefix` | Optional prefix of metadata key 3 (`MODEL_NAME`). |

---

## channels

A map of named channel objects. Each key is a short slug (e.g. `"rfcomm-main"`).

```json
"channels": {
  "rfcomm-main": {
    "transport": "rfcomm",
    "uuid": "0cf12d31-fac3-4553-bd80-d6832e7b3062",
    "secure": false,
    "protocol": {
      "framing": "soundcore_v1",
      "cmd_prefix": "08ee000000",
      "resp_prefix": "09ff000001",
      "checksum": "sum8"
    }
  }
},
"default_channel": "rfcomm-main"
```

### Channel fields

| field | meaning |
|---|---|
| `transport` | `"rfcomm"` (active), `"aacp"` (active, v4+), `"ble_gatt"` (reserved). |
| `uuid` | Service UUID for RFCOMM `createInsecureRfcommSocketToServiceRecord`. |
| `psm` | L2CAP PSM for `aacp` channels (e.g. `4097` = 0x1001). Declarative; the engine holds the constant. |
| `secure` | `false` = insecure RFCOMM (standard for Soundcore). |
| `protocol` | Framing/codec descriptor. See below. |

### protocol (soundcore_v1)

The only RFCOMM protocol currently implemented is `soundcore_v1`:

- **Framing**: host→device: `08 ee 00 00 00 <cmd:2> <len:2 LE total> <payload…> <crc>`;
  device→host: `09 ff 00 00 01 <cmd:2> <len:2 LE> <payload…> <crc>`.
  Command bytes equal OpenSCQ30's `Command([hi, lo])`.
- **Checksum** (`sum8`): `sum(all preceding bytes) & 0xFF`.
- `cmd_prefix` / `resp_prefix`: hex prefixes for the codec (`"08ee000000"` / `"09ff000001"`).

`rfcomm` channels with `framing: soundcore_v1` and `aacp` channels with `framing: aap_v1`
are both driven. `ble_gatt` is a reserved transport slot; a function that names a `ble_gatt`
channel will gracefully degrade (see [graceful degrade](#graceful-degrade)).

---

## platforms

Optional. Describes per-ROM hook injection bindings. Each key is a platform slug
(e.g. `"pixelos"`).

If `platforms` is absent the app uses its built-in `pixelos` defaults.

```json
"platforms": {
  "pixelos": {
    "detect": {
      "manufacturer": "Google",
      "system_prop": { "ro.product.brand": "google" }
    },
    "requires": ["root", "lsposed", "pkg:com.android.systemui", "pkg:com.android.settings"],
    "inject": {
      "settings_pkg": "com.android.settings",
      "systemui_pkg": "com.android.systemui",
      "about_fragment": "com.android.settings.bluetooth.BluetoothDetailsConfigurableFragment",
      "surfaces": ["device_details", "volume_panel"],
      "reserved_ids": { "anc": 1001 }
    }
  }
}
```

### Platform fields

| field | meaning |
|---|---|
| `detect` | ROM match criteria. `manufacturer` matches `Build.MANUFACTURER`; `system_prop` is a map of prop key → expected value. |
| `requires` | Capabilities required for injection. `"root"`, `"lsposed"`, `"pkg:<package>"`. Only ROMs where root + LSPosed exist are eligible. |
| `inject.settings_pkg` | Package to hook for the About/device-details page. |
| `inject.systemui_pkg` | Package to hook for the volume panel. |
| `inject.about_fragment` | Fragment class that hosts the configurable BT detail fragment. |
| `inject.surfaces` | Surfaces this platform can expose: `"device_details"`, `"volume_panel"`. |
| `inject.reserved_ids` | `DeviceSettingItem` IDs that have a fixed meaning (e.g. `"anc": 1001` is the volume-panel ANC tile slot). |

---

## functions[]

Each function is one user-facing capability.

| field | type | meaning |
|---|---|---|
| `id` | string | Stable kebab-case slug. |
| `type` | string | UI control kind — see table below. |
| `channel` | string | Optional. Key into `channels`. Defaults to `default_channel` if absent. |
| `title` / `title_i18n` | string / object | Label + `{lang: text}` overrides. |
| `icon` | string | Logical glyph name for `switch`/`row` controls. Resolved by the app's icon registry: `anc`, `adaptive`, `transparency`, `off`, `dolby`, `surround`, `multipoint`, `ldac`, `ear`, `wind`, `mic`, `battery`, `volume`, `gaming`, `touch`, `tune`. `multitoggle` uses per-option `icon` instead. |
| `summary` / `summary_i18n` | string / object | Subtitle shown under the title on switch/row controls. |
| `capability` | string | OpenSCQ30 module name for provenance. |
| `options[]` | array | For `multitoggle` / `list`: `{id, label, icon?, label_i18n?}`. |
| `range` | object | For `slider`: `{min, max, step, unit?}`. |
| `set` | object | How to write the value. See [set](#set). |
| `read` | object | How to read the current value. See [read](#read). |
| `inject` | `"auto"` / `true` / `false` | Controls injectability. See [injectability](#type--injectability). |
| `inject_reason` | string | Text shown in UI when not injectable (auto-filled when `inject:"auto"` resolves to false). |
| `conflicts_with` | string[] | Function IDs that cannot be active simultaneously. |
| `requires` | object | `{function_id: value}` — this control is only meaningful when another holds that value. |
| `ui.setting_id` | int | The `DeviceSettingItem` ID exposed. `1001` is reserved (volume-panel ANC). Framework range ≥ `2200`. |
| `ui.surfaces` | string[] | Surfaces to render on: `"device_details"`, `"volume_panel"`. |
| `_verified` | bool | `true` only when `set`/`read` bytes were confirmed live on hardware. |

### type → injectability

| `type` | Android preference | Injectable? |
|---|---|---|
| `multitoggle` | `MultiTogglePreference` (SegmentedButton) | Yes, **iff ≤ 4 options**; auto-false with reason `too-many-options` if more. |
| `toggle` | `ActionSwitchPreference` (Switch) | Yes. |
| `list` | no native list pref in the configurable fragment | No (`no-native-list`) — in-app screen only. |
| `slider` | no slider in the configurable fragment | No (`no-native-slider`) — in-app screen only. |
| `info` | `FooterPreference` / read-only row | Display-only (`inject:false`). |

`inject: "auto"` applies these rules automatically. Set `inject: false` (with
`inject_reason`) to force a capability off the native page even when it could render (e.g.
unverified bytes you don't want to expose yet). Set `inject: true` only to override a
heuristic you know is wrong.

---

## set

| field | meaning |
|---|---|
| `command` | Hex command id (2 bytes, = OpenSCQ30 `Command`). |
| `payload_template` | Hex with `{mode}` / `{value}` / `{state}` placeholders. |
| `option_values` | Maps option id → substituted hex (for `multitoggle` / `list`). |
| `state_values` | Maps `on` / `off` → hex (for `toggle`). |

---

## read

| field | meaning |
|---|---|
| `command` | Hex command id to send as a read request (polled transports). |
| `response_command` | Hex command id to match in the device reply. |
| `notify_opcode` | Hex opcode for push-notification transports (`aacp`). The engine matches inbound frames by this opcode. |
| `state_byte_index` | Byte offset in the full response/notification packet holding the current value (`null` if unknown). |
| `value_map` | Maps hex byte → option id or `on`/`off`. |

---

## conflicts & dependencies

- **`conflicts_with`**: when the user enables (or the device reports) two mutually-exclusive
  capabilities the app surfaces the clash on the device card and keeps one, disabling the
  other. Known Soundcore exclusions: **LDAC ↔ Multipoint**, **LDAC ↔ Gaming mode**.
- **`requires`**: a control whose `requires` isn't met is shown but inert (e.g. manual ANC
  level requires `sound_mode = anc`).

---

## per-device user enablement

Injectable capabilities default to **on**. The Devices tab persists an enabled-set per device
MAC. `ConfigProviderService` only emits app-items for capabilities that are `injectable`
**and** enabled **and** whose conflicts are resolved. Non-injectable capabilities are listed
but not toggleable (shown with their `inject_reason`).

---

## icons

Logical icon names (`anc`, `off`, `transparency`, …) map to drawables inside the app so
manifests stay device-agnostic.

---

## Graceful degrade

The app evaluates each function individually before injecting it. A function is marked
`injectable: false` (with a reason code) and **skipped** if any of the following hold — the
rest of the device's functions are unaffected:

| reason code | condition |
|---|---|
| `unsupported-transport` | The named channel's `transport` is not driven by the running app version (e.g. `ble_gatt`, `aacp`). |
| `unsupported-surface` | The function's `ui.surfaces` contains a surface the active platform's `inject.surfaces` doesn't include. |
| `unrenderable-type` | The `type` cannot be rendered as a native preference on the active platform (e.g. `list`, `slider` on Pixel). |

The `schema_version` range check ([3, 4]) is the last-resort gate for structural breaks — a
manifest with an out-of-range version is dropped entirely, not partially.

---

## Adding a device

1. Find the OpenSCQ30 model (`re_model`) and copy its capability list + command bytes.
2. Copy an existing manifest (`manifests/<manufacturer-slug>/<id>.json`) as your starting
   point, set a new `id`, and keep `_verified: false` on every function until confirmed live
   (use the in-app RFCOMM console / test tool).
3. Set `revision: 1` and `revision_date` to today's date.
4. Regenerate the index:
   ```bash
   npm run build-index
   ```
5. Commit **both** the new manifest and the regenerated `index.json`. CI runs `npm run check`
   on every PR; it fails if `index.json` is stale.

### Revision discipline

Bump `revision` (and update `revision_date`) on **every** content edit — including flipping
`_verified`, fixing a byte, or adjusting `inject_reason`. The app uses the revision to detect
whether it needs to refresh cached data.

### Sideload for testing

The Orchestra app can load a local manifest from the device filesystem. A sideloaded manifest
takes the highest precedence (overrides any cloud entry with the same `id`). This lets you
iterate on command bytes without publishing to the repo.
