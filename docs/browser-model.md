# Browser Model

## Probe lifecycle

1. Create a canvas renderer.
2. Measure baseline missing-glyph hashes.
3. Render each sentinel glyph from its committed codepoint sequence.
4. Classify each sentinel as:
   - `true` when the rendered hash differs from the missing-glyph baseline
   - `false` when the rendered hash matches the missing-glyph baseline
   - `null` when the browser blocks readback or produces no measurable pixels
5. Detect a dominant tofu cluster among apparent `true` results.
6. If the cluster satisfies the configured thresholds, flip clustered results to `false`.
7. Pass the sentinel result map and diagnostics to the analysis core.

## Diagnostics

The browser probe emits:

- `userAgent`
- `userAgentData`
- `canvasBlocked`
- `spoofingDetected`
- `tofuCluster`
- `tofuBaselineHashes`

## Reliability model

The analysis core treats these diagnostics as hard guards:

- blocked canvas can reject the run
- spoofed canvas can reject the run
- an uncorrected tofu cluster can reject the run

The goal is to fail explicitly when the browser environment makes the measurement unreliable.
