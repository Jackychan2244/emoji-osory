import { DEFAULT_ANALYSIS_OPTIONS, mergeObjects } from "./defaults.js";
import { createVersionPredicate, sortVersions } from "./versioning.js";

export function getAnalysisOptions(runtimeDataset, overrideOptions = {}) {
  const datasetDefaults =
    runtimeDataset && typeof runtimeDataset === "object"
      ? runtimeDataset.defaults?.analysis
      : undefined;

  return mergeObjects(
    mergeObjects(DEFAULT_ANALYSIS_OPTIONS, datasetDefaults || {}),
    overrideOptions || {},
  );
}

export function getSortedDatasetVersions(
  runtimeDataset,
  analysisOptions,
  direction = "asc",
) {
  const availableVersions = Object.keys(runtimeDataset.unicodeVersions || {});
  const isVersionAllowed = createVersionPredicate(
    analysisOptions.unicodeDetection?.versionFilter,
  );

  return sortVersions(
    availableVersions.filter((version) => isVersionAllowed(version)),
    direction,
  );
}

export function getSentinelIdentifiersForVersion(
  runtimeDataset,
  unicodeVersion,
) {
  const versionRecord = runtimeDataset.unicodeVersions?.[unicodeVersion];
  return Array.isArray(versionRecord?.sentinelIds)
    ? versionRecord.sentinelIds
    : [];
}

export function getCandidateList(runtimeDataset, unicodeVersion) {
  const versionCandidates =
    runtimeDataset.osCandidatesByUnicode?.[unicodeVersion];
  return Array.isArray(versionCandidates)
    ? versionCandidates.map((candidate) => ({ ...candidate }))
    : [];
}
