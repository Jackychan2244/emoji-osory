export const DEFAULT_ANALYSIS_OPTIONS = {
  unicodeDetection: {
    sentinelFullMatchMinCoverage: 0.5,
    fullMatchConfidence: 1,
    partialMatchConfidence: 0.6,
    fallbackConfidence: 0.3,
    versionFilter: {
      mode: "exclude",
      versions: ["12.1", "13.1", "15.1"],
    },
    profile: {
      omitEmptyVersions: true,
    },
  },
  scoring: {
    emojiProfile: {
      enabled: true,
    },
    environmentHints: {
      enabled: true,
      mode: "score",
      weights: {
        uaMatchBonus: 25,
        uaMismatchPenalty: 10,
        appleCrossBonus: 10,
      },
    },
    uaChNarrowing: {
      enabled: true,
      allowAppleCross: true,
    },
  },
  scoreClamp: {
    min: 0,
    max: 125,
  },
  guards: {
    spoofingDetected: {
      enabled: true,
      policy: "reject",
    },
    canvasBlocked: {
      enabled: true,
      policy: "reject",
    },
    tofuCluster: {
      enabled: true,
      policy: "reject",
      requireApplied: true,
      minConsideredTrue: 12,
      minDominantCount: 8,
      minShare: 0.25,
    },
  },
};

export function mergeObjects(baseValue, overrideValue) {
  if (
    !baseValue ||
    typeof baseValue !== "object" ||
    Array.isArray(baseValue) ||
    !overrideValue ||
    typeof overrideValue !== "object" ||
    Array.isArray(overrideValue)
  ) {
    return overrideValue === undefined ? baseValue : overrideValue;
  }

  const mergedValue = { ...baseValue };

  for (const [key, value] of Object.entries(overrideValue)) {
    mergedValue[key] = mergeObjects(mergedValue[key], value);
  }

  return mergedValue;
}
