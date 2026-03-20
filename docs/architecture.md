# Architecture

`emoji-osory` is split into three active layers.

## 1. Analysis core

Location: `src/core/`

Responsibilities:

- compare Unicode version ceilings
- build per-version sentinel pass and fail profiles
- score candidate operating systems from committed vendor data
- apply weak environment hints from UA and UA-CH data
- reject unreliable results when browser diagnostics indicate spoofing or blocked canvas readback

The core is browser-safe and has no dependency on an HTTP runtime.

## 2. Browser probe

Location: `src/browser/`

Responsibilities:

- render sentinel glyphs onto a canvas
- establish baseline missing-glyph hashes
- classify support as `true`, `false`, or `null`
- detect unstable canvas output
- detect dominant tofu hash clusters and optionally correct them client-side

The browser probe produces a plain input envelope consumed by the analysis core.

## 3. Data pipeline

Location: `src/data-build/`

Responsibilities:

- parse Unicode `emoji-test` source files into a codepoint-only master dataset
- normalize vendor data into a consistent committed schema
- derive a full research database
- derive the slim browser runtime dataset used by the demo and package export

## Data flow

1. `data/unicode/emoji-test-*.txt` is parsed into `data/unicode-master.json`.
2. `data/vendors/*.json` is normalized into codepoint-only vendor records.
3. The master builder joins Unicode first-seen data with vendor releases.
4. The full database is emitted to `data/emoji-fingerprint-db.json`.
5. The slim runtime dataset is emitted to `data/browser-runtime-dataset.json`.
6. The browser probe measures sentinels locally.
7. The analysis core scores the result and returns a probability distribution.

## Historical material

Legacy experiments and earlier runtime implementations are kept out of the published repository. They are not part of the public architecture or support surface.
