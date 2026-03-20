import { inferOsFamilyHints, getVendorFamily } from "./environment.js";
import {
  getAnalysisOptions,
  getCandidateList,
  getSentinelIdentifiersForVersion,
  getSortedDatasetVersions,
} from "./dataset.js";
import { compareVersions } from "./versioning.js";

function coerceSentinelResults(inputValue) {
  if (
    inputValue &&
    typeof inputValue === "object" &&
    !Array.isArray(inputValue)
  ) {
    if (
      inputValue.sentinelResults &&
      typeof inputValue.sentinelResults === "object" &&
      !Array.isArray(inputValue.sentinelResults)
    ) {
      return inputValue.sentinelResults;
    }

    return inputValue;
  }

  return {};
}

function coerceInputEnvelope(inputValue) {
  if (
    !inputValue ||
    typeof inputValue !== "object" ||
    Array.isArray(inputValue)
  ) {
    return {
      sentinelResults: {},
      diagnostics: {},
      timestamp: new Date().toISOString(),
    };
  }

  return {
    sentinelResults: coerceSentinelResults(inputValue),
    diagnostics:
      inputValue.diagnostics &&
      typeof inputValue.diagnostics === "object" &&
      !Array.isArray(inputValue.diagnostics)
        ? inputValue.diagnostics
        : {},
    timestamp:
      typeof inputValue.timestamp === "string" && inputValue.timestamp.trim()
        ? inputValue.timestamp
        : new Date().toISOString(),
  };
}

function applyGuardPolicy(policy, warningList, message) {
  if (policy === "reject") {
    return { rejected: true };
  }

  if (policy === "warn") {
    warningList.push(message);
  }

  return { rejected: false };
}

function createFailureResult(message, envelope, warningList = []) {
  return {
    unicodeVersion: null,
    emojiProfile: null,
    candidates: [],
    topMatch: null,
    confidence: 0,
    diagnostics: envelope.diagnostics,
    warnings: warningList.length > 0 ? warningList : undefined,
    error: message,
    timestamp: envelope.timestamp,
  };
}

function detectTofuClusterRisk(tofuCluster, guardOptions) {
  if (!tofuCluster || typeof tofuCluster !== "object") {
    return false;
  }

  const shareSatisfied =
    typeof tofuCluster.share !== "number" ||
    tofuCluster.share >= guardOptions.minShare;
  const consideredSatisfied =
    typeof tofuCluster.consideredTrueCount !== "number" ||
    tofuCluster.consideredTrueCount >= guardOptions.minConsideredTrue;
  const dominantSatisfied =
    typeof tofuCluster.dominantCount !== "number" ||
    tofuCluster.dominantCount >= guardOptions.minDominantCount;

  return Boolean(
    tofuCluster.suspected === true &&
    shareSatisfied &&
    consideredSatisfied &&
    dominantSatisfied,
  );
}

function scoreCandidatesByEmojiProfile(candidateList, emojiProfile) {
  const profileVersions = Object.keys(emojiProfile.versions || {}).sort(
    compareVersions,
  );

  return candidateList.map((candidate) => {
    const normalizedCandidate = {
      ...candidate,
      score: 0,
      signals: {},
    };

    if (!normalizedCandidate.maxEmojiVersion) {
      return normalizedCandidate;
    }

    let matchedSentinelCount = 0;
    let mismatchedSentinelCount = 0;
    let evaluatedSentinelCount = 0;

    for (const version of profileVersions) {
      const versionProfile = emojiProfile.versions[version];

      if (!versionProfile || versionProfile.total === 0) {
        continue;
      }

      const shouldSupportVersion =
        compareVersions(version, normalizedCandidate.maxEmojiVersion) <= 0;

      if (shouldSupportVersion) {
        matchedSentinelCount += versionProfile.passed;
        mismatchedSentinelCount += versionProfile.failed;
      } else {
        matchedSentinelCount += versionProfile.failed;
        mismatchedSentinelCount += versionProfile.passed;
      }

      evaluatedSentinelCount += versionProfile.total;
    }

    const scoredSentinelCount = matchedSentinelCount + mismatchedSentinelCount;
    const accuracy =
      scoredSentinelCount === 0
        ? 0
        : matchedSentinelCount / scoredSentinelCount;

    return {
      ...normalizedCandidate,
      score: Math.round(accuracy * 100),
      signals:
        scoredSentinelCount === 0
          ? {}
          : {
              emojiProfileAccuracy: Number(accuracy.toFixed(3)),
              emojiProfileMismatches: mismatchedSentinelCount,
              emojiProfileEvaluated: evaluatedSentinelCount,
            },
    };
  });
}

function scoreCandidatesByEnvironmentHints(
  candidateList,
  diagnostics,
  analysisOptions,
) {
  const environmentHintsOptions = analysisOptions.scoring.environmentHints;

  if (
    !environmentHintsOptions ||
    environmentHintsOptions.enabled === false ||
    environmentHintsOptions.mode === "disabled"
  ) {
    return candidateList;
  }

  const osFamilyHints = inferOsFamilyHints(diagnostics);
  const scoringWeights = environmentHintsOptions.weights || {};
  const uaMatchBonus = Number(scoringWeights.uaMatchBonus || 25);
  const uaMismatchPenalty = Number(scoringWeights.uaMismatchPenalty || 10);
  const appleCrossBonus = Number(scoringWeights.appleCrossBonus || 10);
  const highestBaseScore =
    environmentHintsOptions.mode === "tie_break_only" &&
    candidateList.length > 0
      ? Math.max(...candidateList.map((candidate) => candidate.score || 0))
      : null;

  return candidateList.map((candidate) => {
    if (highestBaseScore !== null && candidate.score !== highestBaseScore) {
      return candidate;
    }

    const candidateSignals =
      candidate.signals && typeof candidate.signals === "object"
        ? { ...candidate.signals }
        : {};

    let scoreDelta = 0;

    if (osFamilyHints.family !== "unknown") {
      const candidateFamily = getVendorFamily(candidate.vendor);
      const familyMatch = candidateFamily === osFamilyHints.family;
      const appleCrossMatch =
        (candidateFamily === "ios" && osFamilyHints.family === "macos") ||
        (candidateFamily === "macos" && osFamilyHints.family === "ios");

      if (familyMatch) {
        scoreDelta += uaMatchBonus;
      } else if (appleCrossMatch) {
        scoreDelta += appleCrossBonus;
      } else {
        scoreDelta -= uaMismatchPenalty;
      }

      candidateSignals.uaFamily = osFamilyHints.family;
      candidateSignals.uaSource = osFamilyHints.source;
      candidateSignals.uaFamilyMatch = familyMatch;
    }

    return {
      ...candidate,
      score: Math.round((candidate.score || 0) + scoreDelta),
      signals: candidateSignals,
    };
  });
}

export function buildSentinelProfile(
  inputValue,
  runtimeDataset,
  overrideOptions = {},
) {
  const sentinelResults = coerceSentinelResults(inputValue);
  const analysisOptions = getAnalysisOptions(runtimeDataset, overrideOptions);
  const orderedVersions = getSortedDatasetVersions(
    runtimeDataset,
    analysisOptions,
    "asc",
  );
  const omitEmptyVersions =
    analysisOptions.unicodeDetection?.profile?.omitEmptyVersions !== false;

  const profile = {
    versions: {},
    totals: {
      passed: 0,
      failed: 0,
      unknown: 0,
      total: 0,
    },
  };

  for (const version of orderedVersions) {
    const sentinelIdentifiers = getSentinelIdentifiersForVersion(
      runtimeDataset,
      version,
    );

    if (omitEmptyVersions && sentinelIdentifiers.length === 0) {
      continue;
    }

    let passedCount = 0;
    let failedCount = 0;
    let unknownCount = 0;

    for (const sentinelIdentifier of sentinelIdentifiers) {
      const measuredValue = sentinelResults[sentinelIdentifier];

      if (measuredValue === true) {
        passedCount += 1;
      } else if (measuredValue === false) {
        failedCount += 1;
      } else {
        unknownCount += 1;
      }
    }

    const evaluatedCount = passedCount + failedCount;

    profile.versions[version] = {
      passed: passedCount,
      failed: failedCount,
      unknown: unknownCount,
      total: evaluatedCount,
      passRatio: evaluatedCount === 0 ? null : passedCount / evaluatedCount,
    };

    profile.totals.passed += passedCount;
    profile.totals.failed += failedCount;
    profile.totals.unknown += unknownCount;
  }

  profile.totals.total = profile.totals.passed + profile.totals.failed;
  return profile;
}

export function detectUnicodeVersion(
  inputValue,
  runtimeDataset,
  overrideOptions = {},
) {
  const sentinelResults = coerceSentinelResults(inputValue);
  const analysisOptions = getAnalysisOptions(runtimeDataset, overrideOptions);
  const orderedVersions = getSortedDatasetVersions(
    runtimeDataset,
    analysisOptions,
    "desc",
  );
  const detectionOptions = analysisOptions.unicodeDetection || {};
  const minimumCoverage =
    typeof detectionOptions.sentinelFullMatchMinCoverage === "number"
      ? detectionOptions.sentinelFullMatchMinCoverage
      : 0.5;

  let hasKnownSentinelResults = false;

  for (const version of orderedVersions) {
    const sentinelIdentifiers = getSentinelIdentifiersForVersion(
      runtimeDataset,
      version,
    );

    if (sentinelIdentifiers.length === 0) {
      continue;
    }

    const knownValues = sentinelIdentifiers
      .map((sentinelIdentifier) => sentinelResults[sentinelIdentifier])
      .filter(
        (measuredValue) => measuredValue === true || measuredValue === false,
      );

    if (knownValues.length === 0) {
      continue;
    }

    hasKnownSentinelResults = true;

    const coverageRatio = knownValues.length / sentinelIdentifiers.length;
    const allSentinelsPassed = knownValues.every(
      (measuredValue) => measuredValue === true,
    );

    if (allSentinelsPassed && coverageRatio >= minimumCoverage) {
      return {
        version,
        confidence:
          typeof detectionOptions.fullMatchConfidence === "number"
            ? detectionOptions.fullMatchConfidence
            : 1,
        method: "sentinel_full_match",
      };
    }
  }

  for (const version of orderedVersions) {
    const sentinelIdentifiers = getSentinelIdentifiersForVersion(
      runtimeDataset,
      version,
    );
    const hasAnyPassingSentinel = sentinelIdentifiers.some(
      (sentinelIdentifier) => sentinelResults[sentinelIdentifier] === true,
    );

    if (hasAnyPassingSentinel) {
      return {
        version,
        confidence:
          typeof detectionOptions.partialMatchConfidence === "number"
            ? detectionOptions.partialMatchConfidence
            : 0.6,
        method: "sentinel_partial_match",
      };
    }
  }

  if (!hasKnownSentinelResults) {
    return {
      version: null,
      confidence: 0,
      method: "no_data",
    };
  }

  const oldestVersion = orderedVersions[orderedVersions.length - 1] || null;

  return {
    version: oldestVersion,
    confidence:
      typeof detectionOptions.fallbackConfidence === "number"
        ? detectionOptions.fallbackConfidence
        : 0.3,
    method: "fallback_minimum",
  };
}

export function analyzeFingerprint(
  inputValue,
  runtimeDataset,
  overrideOptions = {},
) {
  const envelope = coerceInputEnvelope(inputValue);
  const analysisOptions = getAnalysisOptions(runtimeDataset, overrideOptions);
  const warningList = [];

  if (
    analysisOptions.guards?.spoofingDetected?.enabled &&
    envelope.diagnostics.spoofingDetected
  ) {
    const decision = applyGuardPolicy(
      analysisOptions.guards.spoofingDetected.policy || "reject",
      warningList,
      "Canvas spoofing detected. Results are unreliable.",
    );

    if (decision.rejected) {
      return createFailureResult(
        "Canvas spoofing detected. Results are unreliable.",
        envelope,
      );
    }
  }

  if (
    analysisOptions.guards?.canvasBlocked?.enabled &&
    envelope.diagnostics.canvasBlocked
  ) {
    const decision = applyGuardPolicy(
      analysisOptions.guards.canvasBlocked.policy || "reject",
      warningList,
      "Canvas readback is blocked. Results are unreliable.",
    );

    if (decision.rejected) {
      return createFailureResult(
        "Canvas readback is blocked. Results are unreliable.",
        envelope,
      );
    }
  }

  if (analysisOptions.guards?.tofuCluster?.enabled) {
    const tofuCluster = envelope.diagnostics.tofuCluster;
    const tofuClusterRisk = detectTofuClusterRisk(
      tofuCluster,
      analysisOptions.guards.tofuCluster,
    );

    if (
      tofuClusterRisk &&
      analysisOptions.guards.tofuCluster.requireApplied &&
      tofuCluster?.applied !== true
    ) {
      const decision = applyGuardPolicy(
        analysisOptions.guards.tofuCluster.policy || "reject",
        warningList,
        "A dominant missing-glyph cluster was detected in the canvas measurements.",
      );

      if (decision.rejected) {
        return createFailureResult(
          "A dominant missing-glyph cluster was detected in the canvas measurements.",
          envelope,
        );
      }
    }
  }

  const unicodeVersion = detectUnicodeVersion(
    envelope.sentinelResults,
    runtimeDataset,
    analysisOptions,
  );
  const emojiProfile = buildSentinelProfile(
    envelope.sentinelResults,
    runtimeDataset,
    analysisOptions,
  );

  if (!unicodeVersion.version) {
    return {
      unicodeVersion,
      emojiProfile,
      candidates: [],
      topMatch: null,
      confidence: 0,
      diagnostics: envelope.diagnostics,
      warnings: warningList.length > 0 ? warningList : undefined,
      error: warningList[0] || "No usable sentinel results were collected.",
      timestamp: envelope.timestamp,
    };
  }

  let candidateList = getCandidateList(runtimeDataset, unicodeVersion.version);

  if (candidateList.length === 0) {
    return {
      unicodeVersion,
      emojiProfile,
      candidates: [],
      topMatch: null,
      confidence: 0,
      diagnostics: envelope.diagnostics,
      warnings: warningList.length > 0 ? warningList : undefined,
      error:
        warningList[0] ||
        "No operating-system candidates are available for the detected Unicode version.",
      timestamp: envelope.timestamp,
    };
  }

  if (analysisOptions.scoring?.emojiProfile?.enabled !== false) {
    candidateList = scoreCandidatesByEmojiProfile(candidateList, emojiProfile);
  } else {
    candidateList = candidateList.map((candidate) => ({
      ...candidate,
      score: candidate.score || 0,
      signals: candidate.signals || {},
    }));
  }

  candidateList = scoreCandidatesByEnvironmentHints(
    candidateList,
    envelope.diagnostics,
    analysisOptions,
  );

  const osFamilyHints = inferOsFamilyHints(envelope.diagnostics);
  const uaChNarrowingOptions = analysisOptions.scoring?.uaChNarrowing;

  if (
    uaChNarrowingOptions?.enabled &&
    osFamilyHints.source === "ua_ch" &&
    osFamilyHints.family !== "unknown"
  ) {
    const allowedFamilies = new Set([osFamilyHints.family]);

    if (uaChNarrowingOptions.allowAppleCross) {
      if (osFamilyHints.family === "ios") {
        allowedFamilies.add("macos");
      }

      if (osFamilyHints.family === "macos") {
        allowedFamilies.add("ios");
      }
    }

    const narrowedCandidates = candidateList.filter((candidate) =>
      allowedFamilies.has(getVendorFamily(candidate.vendor)),
    );

    if (narrowedCandidates.length > 0) {
      candidateList = narrowedCandidates;
    }
  }

  const minimumScore = Number(analysisOptions.scoreClamp?.min ?? 0);
  const maximumScore = Number(analysisOptions.scoreClamp?.max ?? 125);

  candidateList = candidateList
    .map((candidate) => ({
      ...candidate,
      score: Math.max(
        minimumScore,
        Math.min(maximumScore, Number(candidate.score || 0)),
      ),
    }))
    .sort(
      (leftCandidate, rightCandidate) =>
        rightCandidate.score - leftCandidate.score,
    );

  const totalPositiveScore = candidateList.reduce(
    (accumulator, candidate) => accumulator + Math.max(candidate.score, 0),
    0,
  );
  const uniformProbability =
    candidateList.length === 0 ? 0 : 1 / candidateList.length;

  const candidates = candidateList.map((candidate) => ({
    ...candidate,
    probability:
      totalPositiveScore > 0
        ? candidate.score / totalPositiveScore
        : uniformProbability,
  }));

  const topMatch = candidates[0] || null;

  return {
    unicodeVersion,
    emojiProfile,
    candidates,
    topMatch,
    confidence: topMatch ? topMatch.probability : 0,
    diagnostics: envelope.diagnostics,
    warnings: warningList.length > 0 ? warningList : undefined,
    timestamp: envelope.timestamp,
  };
}
