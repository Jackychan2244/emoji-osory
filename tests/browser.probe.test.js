import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { createBrowserProbe } from "../src/browser/index.js";
import { materializeCodepoints } from "../src/index.js";

const repositoryRoot = process.cwd();
const runtimeDataset = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "data", "browser-runtime-dataset.json"),
    "utf8",
  ),
);
const sentinelIds = Object.keys(runtimeDataset.sentinels);

describe("browser probe", () => {
  it("reports a blocked canvas when the renderer cannot read pixels", async () => {
    const browserProbe = createBrowserProbe({
      rendererFactory() {
        return {
          blocked: true,
          spoofing: false,
          baselineHashes: [],
          measureGlyph() {
            return {
              hash: 0,
              nonZeroPixelCount: 0,
              colorPixelCount: 0,
              error: new Error("blocked"),
            };
          },
          isBaselineHash() {
            return true;
          },
        };
      },
    });

    const fingerprintInput = await browserProbe.run(runtimeDataset);

    expect(fingerprintInput.diagnostics.canvasBlocked).toBe(true);
    expect(
      Object.values(fingerprintInput.sentinelResults).every(
        (measuredValue) => measuredValue === null,
      ),
    ).toBe(true);
  });

  it("reports spoofing when the renderer is unstable", async () => {
    const browserProbe = createBrowserProbe({
      rendererFactory() {
        return {
          blocked: false,
          spoofing: true,
          baselineHashes: [],
          measureGlyph() {
            return {
              hash: 0,
              nonZeroPixelCount: 0,
              colorPixelCount: 0,
              error: new Error("spoofing"),
            };
          },
          isBaselineHash() {
            return true;
          },
        };
      },
    });

    const fingerprintInput = await browserProbe.run(runtimeDataset);

    expect(fingerprintInput.diagnostics.spoofingDetected).toBe(true);
  });

  it("marks supported and unsupported sentinels from renderer hashes", async () => {
    const supportedGlyph = materializeCodepoints(
      runtimeDataset.sentinels[sentinelIds[0]].codepoints,
    );
    const unsupportedGlyph = materializeCodepoints(
      runtimeDataset.sentinels[sentinelIds[1]].codepoints,
    );
    const browserProbe = createBrowserProbe({
      tofuClusterOptions: {
        enabled: false,
      },
      rendererFactory() {
        return {
          blocked: false,
          spoofing: false,
          baselineHashes: [10],
          measureGlyph(glyphValue) {
            if (glyphValue === supportedGlyph) {
              return {
                hash: 99,
                nonZeroPixelCount: 12,
                colorPixelCount: 12,
              };
            }

            if (glyphValue === unsupportedGlyph) {
              return {
                hash: 10,
                nonZeroPixelCount: 12,
                colorPixelCount: 0,
              };
            }

            return {
              hash: 99,
              nonZeroPixelCount: 12,
              colorPixelCount: 12,
            };
          },
          isBaselineHash(hashValue) {
            return hashValue === 10;
          },
        };
      },
    });

    const fingerprintInput = await browserProbe.run({
      ...runtimeDataset,
      sentinels: Object.fromEntries(
        sentinelIds
          .slice(0, 2)
          .map((sentinelId) => [
            sentinelId,
            runtimeDataset.sentinels[sentinelId],
          ]),
      ),
    });

    expect(fingerprintInput.sentinelResults[sentinelIds[0]]).toBe(true);
    expect(fingerprintInput.sentinelResults[sentinelIds[1]]).toBe(false);
  });

  it("applies tofu correction when a dominant hash cluster appears", async () => {
    const targetIds = sentinelIds.slice(0, 3);
    const browserProbe = createBrowserProbe({
      tofuClusterOptions: {
        enabled: true,
        applyCorrection: true,
        minConsideredTrue: 2,
        minDominantCount: 2,
        minShare: 0.5,
      },
      rendererFactory() {
        return {
          blocked: false,
          spoofing: false,
          baselineHashes: [10],
          measureGlyph() {
            return {
              hash: 77,
              nonZeroPixelCount: 12,
              colorPixelCount: 12,
            };
          },
          isBaselineHash(hashValue) {
            return hashValue === 10;
          },
        };
      },
    });

    const fingerprintInput = await browserProbe.run({
      ...runtimeDataset,
      sentinels: Object.fromEntries(
        targetIds.map((sentinelId) => [
          sentinelId,
          runtimeDataset.sentinels[sentinelId],
        ]),
      ),
    });

    expect(fingerprintInput.diagnostics.tofuCluster.applied).toBe(true);
    expect(
      targetIds.every(
        (sentinelId) => fingerprintInput.sentinelResults[sentinelId] === false,
      ),
    ).toBe(true);
  });

  it("treats monochrome fallback glyphs as unsupported", async () => {
    const browserProbe = createBrowserProbe({
      rendererFactory() {
        return {
          blocked: false,
          spoofing: false,
          baselineHashes: [10],
          measureGlyph() {
            return {
              hash: 44,
              nonZeroPixelCount: 24,
              colorPixelCount: 0,
            };
          },
          isBaselineHash(hashValue) {
            return hashValue === 10;
          },
        };
      },
    });

    const targetId = sentinelIds[0];
    const fingerprintInput = await browserProbe.run({
      ...runtimeDataset,
      sentinels: {
        [targetId]: runtimeDataset.sentinels[targetId],
      },
    });

    expect(fingerprintInput.sentinelResults[targetId]).toBe(false);
    expect(fingerprintInput.diagnostics.monochromeFallbackCount).toBe(1);
  });
});
