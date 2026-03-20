# Data Pipeline

## Inputs

- `data/unicode/emoji-test-*.txt`
- `data/vendors/*.json`

The Unicode source files are third-party reference inputs. Active generated JSON outputs are codepoint-only.

## Commands

Parse Unicode source:

```bash
npm run parse
```

Generate Noto release mappings:

```bash
npm run noto
```

Normalize vendor data:

```bash
npm run sanitize
```

Build committed datasets:

```bash
npm run build:data
```

## Output contracts

### `data/unicode-master.json`

- `unicodeVersions[version].sentinelEmojis`
- `unicodeVersions[version].allEmojis`
- each emoji record stores `id`, `codepoints`, `name`, `unicodeVersion`, and structural flags

### `data/emoji-fingerprint-db.json`

- `unicodeVersions`
- `vendors`
- `osCandidatesByUnicode`
- `metadata`

This is the full research database and includes vendor emoji lists where available.

### `data/browser-runtime-dataset.json`

- `defaults.analysis`
- `defaults.browser`
- `unicodeVersions[version].sentinelIds`
- `sentinels`
- `osCandidatesByUnicode`

This is the public runtime artifact used by the package and demo.

## Reproducibility

The tests compare a fresh build from `src/data-build/` against the committed datasets. A data change is incomplete until the generated files and tests agree.
