import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import {
  analyzeFingerprint,
  buildSentinelProfile,
  detectUnicodeVersion,
  materializeCodepoints,
} from "../src/index.js";

const repositoryRoot = process.cwd();
const runtimeDataset = JSON.parse(
  fs.readFileSync(
    path.join(repositoryRoot, "data", "browser-runtime-dataset.json"),
    "utf8",
  ),
);

function buildSentinelResults(version, measuredValue = true) {
  return Object.fromEntries(
    runtimeDataset.unicodeVersions[version].sentinelIds.map((sentinelId) => [
      sentinelId,
      measuredValue,
    ]),
  );
}

describe("analysis core", () => {
  it("materializes codepoints into a runtime glyph", () => {
    expect(materializeCodepoints(["1F600"])).toBe(
      String.fromCodePoint(0x1f600),
    );
  });

  it("detects a full sentinel match when an entire version passes", () => {
    const sentinelResults = buildSentinelResults("14.0", true);

    expect(detectUnicodeVersion(sentinelResults, runtimeDataset)).toEqual({
      version: "14.0",
      confidence: 1,
      method: "sentinel_full_match",
    });
  });

  it("falls back to a partial match when only one sentinel is known", () => {
    const sentinelResults = {
      [runtimeDataset.unicodeVersions["15.0"].sentinelIds[0]]: true,
    };

    expect(detectUnicodeVersion(sentinelResults, runtimeDataset)).toEqual({
      version: "15.0",
      confidence: 0.6,
      method: "sentinel_partial_match",
    });
  });

  it("returns no data when no sentinel results are known", () => {
    expect(detectUnicodeVersion({}, runtimeDataset)).toEqual({
      version: null,
      confidence: 0,
      method: "no_data",
    });
  });

  it("builds a sentinel profile with passed and failed counts", () => {
    const version = "10.0";
    const sentinelIds = runtimeDataset.unicodeVersions[version].sentinelIds;
    const sentinelResults = {
      [sentinelIds[0]]: true,
      [sentinelIds[1]]: false,
    };
    const profile = buildSentinelProfile(sentinelResults, runtimeDataset);

    expect(profile.versions[version]).toMatchObject({
      passed: 1,
      failed: 1,
      total: 2,
    });
  });

  it("applies environment hints to rank the most plausible candidate", () => {
    const sentinelResults = {
      ...buildSentinelResults("15.0", true),
      ...buildSentinelResults("16.0", false),
      ...buildSentinelResults("17.0", false),
    };
    const analysisResult = analyzeFingerprint(
      {
        sentinelResults,
        diagnostics: {
          userAgent:
            "Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 Version/16.4 Mobile/15E148 Safari/604.1",
        },
      },
      runtimeDataset,
    );

    expect(analysisResult.topMatch?.vendor).toBe("apple_ios");
    expect(analysisResult.topMatch?.maxEmojiVersion).toBe("15.0");
  });

  it("rejects analysis when a tofu cluster is detected but not corrected", () => {
    const sentinelResults = buildSentinelResults("15.0", true);
    const analysisResult = analyzeFingerprint(
      {
        sentinelResults,
        diagnostics: {
          tofuCluster: {
            suspected: true,
            applied: false,
            consideredTrueCount: 20,
            dominantCount: 12,
            share: 0.6,
          },
        },
      },
      runtimeDataset,
    );

    expect(analysisResult.error).toMatch(/missing-glyph cluster/i);
    expect(analysisResult.topMatch).toBeNull();
  });
});
