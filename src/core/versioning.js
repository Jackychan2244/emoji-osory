export function compareVersions(leftVersion, rightVersion) {
  const leftParts = String(leftVersion || "")
    .split(".")
    .map((value) => Number.parseInt(value, 10) || 0);
  const rightParts = String(rightVersion || "")
    .split(".")
    .map((value) => Number.parseInt(value, 10) || 0);
  const width = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < width; index += 1) {
    const leftValue = leftParts[index] || 0;
    const rightValue = rightParts[index] || 0;

    if (leftValue > rightValue) {
      return 1;
    }

    if (leftValue < rightValue) {
      return -1;
    }
  }

  return 0;
}

export function sortVersions(versionList, direction = "asc") {
  const sortedVersions = [...versionList].sort(compareVersions);
  return direction === "desc" ? sortedVersions.reverse() : sortedVersions;
}

export function createVersionPredicate(versionFilter = {}) {
  const { mode = "exclude", versions = [] } =
    versionFilter && typeof versionFilter === "object" ? versionFilter : {};

  const targetVersions = new Set(
    Array.isArray(versions) ? versions.map((value) => String(value)) : [],
  );

  if (targetVersions.size === 0) {
    return () => true;
  }

  if (mode === "include") {
    return (version) => targetVersions.has(String(version));
  }

  return (version) => !targetVersions.has(String(version));
}
