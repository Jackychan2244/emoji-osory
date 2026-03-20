import path from "path";
import {
  BROWSER_RUNTIME_DATASET_PATH,
  FULL_DATABASE_MINIFIED_PATH,
  FULL_DATABASE_PATH,
  UNICODE_MASTER_PATH,
  VENDOR_DATA_DIRECTORY,
  compareVersions,
  createEmojiIdentifier,
  listFiles,
  readJsonFile,
  sortVersions,
  writeJsonFile,
} from "./shared.js";

const ANALYSIS_DEFAULTS = {
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

const BROWSER_DEFAULTS = {
  tofuCluster: {
    enabled: true,
    applyCorrection: true,
    minConsideredTrue: 12,
    minDominantCount: 8,
    minShare: 0.25,
  },
  supportDetection: {
    requireColorEmoji: true,
    minimumColorPixelCount: 8,
    minimumColorShare: 0.03,
  },
};

function isVendorFile(fileName) {
  return (
    fileName.endsWith(".json") &&
    !fileName.endsWith(".bak") &&
    !fileName.endsWith(".tmp") &&
    !fileName.endsWith(".unresolved.json")
  );
}

function buildEmojiFirstSeenIndex(unicodeMasterDatabase) {
  const firstSeenIndex = new Map();
  const orderedVersions = sortVersions(
    Object.keys(unicodeMasterDatabase.unicodeVersions || {}),
  );

  for (const unicodeVersion of orderedVersions) {
    const allEmojis =
      unicodeMasterDatabase.unicodeVersions[unicodeVersion]?.allEmojis || [];

    for (const emojiRecord of allEmojis) {
      const emojiIdentifier =
        emojiRecord.id || createEmojiIdentifier(emojiRecord.codepoints);

      if (!firstSeenIndex.has(emojiIdentifier)) {
        firstSeenIndex.set(emojiIdentifier, unicodeVersion);
      }
    }
  }

  return firstSeenIndex;
}

function inferMaxEmojiVersion(vendorEntry, firstSeenIndex) {
  let detectedVersion = vendorEntry.maxEmojiVersion || null;

  for (const emojiRecord of vendorEntry.emojis || []) {
    const emojiIdentifier =
      emojiRecord.id || createEmojiIdentifier(emojiRecord.codepoints);
    const unicodeVersion = firstSeenIndex.get(emojiIdentifier);

    if (
      unicodeVersion &&
      (!detectedVersion || compareVersions(unicodeVersion, detectedVersion) > 0)
    ) {
      detectedVersion = unicodeVersion;
    }
  }

  return detectedVersion;
}

function loadVendors(firstSeenIndex) {
  const vendorFiles = listFiles(VENDOR_DATA_DIRECTORY, isVendorFile);
  const vendors = {};

  for (const vendorFile of vendorFiles) {
    const vendorKey = vendorFile.replace(/\.json$/i, "");
    const vendorEntries = readJsonFile(
      path.join(VENDOR_DATA_DIRECTORY, vendorFile),
    );

    if (!Array.isArray(vendorEntries)) {
      continue;
    }

    vendors[vendorKey] = {};

    for (const vendorEntry of vendorEntries) {
      if (
        !vendorEntry ||
        typeof vendorEntry !== "object" ||
        vendorEntry.error
      ) {
        continue;
      }

      const maxEmojiVersion = inferMaxEmojiVersion(vendorEntry, firstSeenIndex);

      vendors[vendorKey][vendorEntry.osVersion] = {
        releaseDate: vendorEntry.releaseDate || null,
        maxEmojiVersion,
        emojiVersionsMentioned: Array.isArray(
          vendorEntry.emojiVersionsMentioned,
        )
          ? vendorEntry.emojiVersionsMentioned
          : [],
        emojiCount:
          typeof vendorEntry.emojisFound === "number"
            ? vendorEntry.emojisFound
            : Array.isArray(vendorEntry.emojis)
              ? vendorEntry.emojis.length
              : 0,
        emojis: Array.isArray(vendorEntry.emojis) ? vendorEntry.emojis : [],
        sourceUrl: vendorEntry.sourceUrl || null,
        isGenerated: Boolean(vendorEntry.isGenerated),
      };
    }
  }

  return vendors;
}

function buildOsCandidatesByUnicode(unicodeMasterDatabase, vendors) {
  const orderedVersions = sortVersions(
    Object.keys(unicodeMasterDatabase.unicodeVersions || {}),
  );
  const osCandidatesByUnicode = {};

  for (const unicodeVersion of orderedVersions) {
    const candidateMap = new Map();

    for (const [vendorKey, vendorRecords] of Object.entries(vendors)) {
      for (const [osVersion, vendorRecord] of Object.entries(vendorRecords)) {
        if (
          vendorRecord.maxEmojiVersion &&
          compareVersions(vendorRecord.maxEmojiVersion, unicodeVersion) >= 0
        ) {
          const candidateKey = `${vendorKey}:${osVersion}`;
          const candidateValue = {
            vendor: vendorKey,
            osVersion,
            maxEmojiVersion: vendorRecord.maxEmojiVersion,
            releaseDate: vendorRecord.releaseDate,
          };

          const existingCandidate = candidateMap.get(candidateKey);

          if (
            !existingCandidate ||
            compareVersions(
              candidateValue.maxEmojiVersion,
              existingCandidate.maxEmojiVersion,
            ) > 0
          ) {
            candidateMap.set(candidateKey, candidateValue);
          }
        }
      }
    }

    osCandidatesByUnicode[unicodeVersion] = [...candidateMap.values()].sort(
      (leftCandidate, rightCandidate) =>
        compareVersions(
          leftCandidate.maxEmojiVersion,
          rightCandidate.maxEmojiVersion,
        ),
    );
  }

  return osCandidatesByUnicode;
}

function buildBrowserRuntimeDataset(fullDatabase) {
  const sentinels = {};
  const unicodeVersions = {};

  for (const [unicodeVersion, versionRecord] of Object.entries(
    fullDatabase.unicodeVersions || {},
  )) {
    const sentinelIds = [];

    for (const sentinelRecord of versionRecord.sentinelEmojis || []) {
      sentinels[sentinelRecord.id] = {
        id: sentinelRecord.id,
        codepoints: sentinelRecord.codepoints,
        name: sentinelRecord.name,
        unicodeVersion: sentinelRecord.unicodeVersion,
        group: sentinelRecord.group,
        subgroup: sentinelRecord.subgroup,
      };
      sentinelIds.push(sentinelRecord.id);
    }

    unicodeVersions[unicodeVersion] = {
      releaseDate: versionRecord.releaseDate,
      fullEmojiCount: versionRecord.fullEmojiCount,
      sentinelIds,
    };
  }

  return {
    version: fullDatabase.version,
    generated: fullDatabase.generated,
    metadata: fullDatabase.metadata,
    defaults: {
      analysis: ANALYSIS_DEFAULTS,
      browser: BROWSER_DEFAULTS,
    },
    unicodeVersions,
    sentinels,
    osCandidatesByUnicode: fullDatabase.osCandidatesByUnicode,
  };
}

export function buildMasterDatabase() {
  const unicodeMasterDatabase = readJsonFile(UNICODE_MASTER_PATH);
  const firstSeenIndex = buildEmojiFirstSeenIndex(unicodeMasterDatabase);
  const vendors = loadVendors(firstSeenIndex);
  const osCandidatesByUnicode = buildOsCandidatesByUnicode(
    unicodeMasterDatabase,
    vendors,
  );
  const metadata = {
    unicodeVersionsCovered: Object.keys(
      unicodeMasterDatabase.unicodeVersions || {},
    ),
    vendorsCovered: Object.keys(vendors),
    totalOsVersions: Object.values(vendors).reduce(
      (accumulator, vendorRecords) =>
        accumulator + Object.keys(vendorRecords).length,
      0,
    ),
  };
  const fullDatabase = {
    version: "2.0.0",
    generated: new Date().toISOString(),
    metadata,
    unicodeVersions: unicodeMasterDatabase.unicodeVersions,
    vendors,
    osCandidatesByUnicode,
  };

  return {
    fullDatabase,
    browserRuntimeDataset: buildBrowserRuntimeDataset(fullDatabase),
  };
}

export function main() {
  const { fullDatabase, browserRuntimeDataset } = buildMasterDatabase();

  writeJsonFile(FULL_DATABASE_PATH, fullDatabase);
  writeJsonFile(FULL_DATABASE_MINIFIED_PATH, fullDatabase, { minified: true });
  writeJsonFile(BROWSER_RUNTIME_DATASET_PATH, browserRuntimeDataset);

  console.log(`full database written to ${FULL_DATABASE_PATH}`);
  console.log(`minified database written to ${FULL_DATABASE_MINIFIED_PATH}`);
  console.log(
    `browser runtime dataset written to ${BROWSER_RUNTIME_DATASET_PATH}`,
  );
}
