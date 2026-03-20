# Contributing

## Expectations

- Keep the public product browser-first.
- Archive legacy or abandoned paths instead of deleting them when historical context matters.
- Do not add raw emoji glyphs to authored source, config, docs, or committed JSON outputs.
- Keep comments limited to decisions that are not obvious from the code itself.

## Local workflow

```bash
npm install
npm run verify
```

If you change the data pipeline or committed JSON outputs, rebuild them before opening a pull request:

```bash
npm run build:data
```

## Data changes

- `data/unicode/` is the upstream Unicode source corpus.
- `data/vendors/` is vendor provenance data after normalization.
- `data/browser-runtime-dataset.json` is the public runtime artifact and must stay codepoint-only.

Any change to committed datasets should include:

- regenerated outputs
- tests updated if the schema changed
- documentation updated if the public behavior changed

## Pull requests

A pull request should describe:

- the user-facing or maintainer-facing problem
- the chosen approach and the main tradeoff
- how the change was verified

## Release bar

Public-facing changes are expected to pass:

- `npm run lint`
- `npm run test`
- `npm run check:no-emoji`
- `npm run build`
