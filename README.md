# emoji-osory

`emoji-osory` is a browser-first emoji fingerprinting toolkit. It measures which sentinel glyphs your browser can render, scores the result against a committed vendor dataset, and produces a ranked operating-system distribution without requiring a backend.

The public package exposes a browser-safe analysis core and a browser probe. The demo is a static Vite bundle intended for GitHub Pages.

## Demo

Planned GitHub Pages URL:

`https://jackychan2244.github.io/emoji-osory/`

## Quick start

```bash
npm install
npm run verify
npm run dev
```

Build the published artifacts:

```bash
npm run build
```

The browser bundle is emitted to `dist/`.

## Package surface

Core entry:

```js
import {
  analyzeFingerprint,
  buildSentinelProfile,
  detectUnicodeVersion,
} from "emoji-osory";
```

Browser probe entry:

```js
import { createBrowserProbe } from "emoji-osory/browser";
```

Bundled runtime dataset:

```js
import runtimeDataset from "emoji-osory/runtime-dataset";
```

Primary interfaces:

- `analyzeFingerprint(input, runtimeDataset, options)` returns Unicode detection, ranked candidates, confidence, and diagnostics.
- `detectUnicodeVersion(input, runtimeDataset, options)` returns the best-supported Unicode ceiling from sentinel outcomes.
- `buildSentinelProfile(input, runtimeDataset, options)` returns passed, failed, and unknown counts per Unicode version.
- `createBrowserProbe(options)` creates a browser-side collector that measures sentinel support through a canvas renderer.

## Repository layout

```text
.
├── data/                  # Committed datasets and raw Unicode source files
├── demo/                  # Static demo application
├── docs/                  # Architecture and usage documentation
├── src/
│   ├── browser/           # Browser probe and canvas measurement logic
│   ├── core/              # Browser-safe analysis core
│   └── data-build/        # Deterministic data generators
├── scripts/               # Thin wrappers for maintenance commands
├── tests/                 # Unit and dataset tests
└── tools/                 # Repository hygiene checks
```

## Data pipeline

The committed data model is codepoint-only. Active JSON outputs do not store raw glyph characters.

Commands:

```bash
npm run parse
npm run noto
npm run sanitize
npm run build:data
```

Outputs:

- `data/unicode-master.json` contains parsed Unicode source data and sentinel sets.
- `data/emoji-fingerprint-db.json` contains the full research database.
- `data/browser-runtime-dataset.json` contains the slim runtime dataset used by the package and demo.

`data/unicode/` remains as the upstream Unicode source corpus and is excluded from the repository emoji-glyph check because it is third-party reference material, not authored runtime data.

## Privacy and limitations

This project is a fingerprinting signal, not an identity system. It should be used with disclosure, consent, and policy review appropriate to your environment.

Known limits:

- Multiple operating systems can share the same Unicode ceiling.
- Browser privacy tools can block or perturb canvas readback.
- User-agent hints are treated as weak tie-break signals, not ground truth.
- Vendor release mappings are committed data and require maintenance when new Unicode or OS releases arrive.

## Development commands

```bash
npm run lint
npm run test
npm run check:no-emoji
npm run verify
```

## License

The project is released under the repository `LICENSE`, which permits non-commercial use and requires separate permission for commercial use.
