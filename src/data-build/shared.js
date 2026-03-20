import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));

export const REPOSITORY_ROOT = path.resolve(moduleDirectory, "..", "..");
export const DATA_DIRECTORY = path.join(REPOSITORY_ROOT, "data");
export const UNICODE_SOURCE_DIRECTORY = path.join(DATA_DIRECTORY, "unicode");
export const VENDOR_DATA_DIRECTORY = path.join(DATA_DIRECTORY, "vendors");
export const UNICODE_MASTER_PATH = path.join(
  DATA_DIRECTORY,
  "unicode-master.json",
);
export const FULL_DATABASE_PATH = path.join(
  DATA_DIRECTORY,
  "emoji-fingerprint-db.json",
);
export const FULL_DATABASE_MINIFIED_PATH = path.join(
  DATA_DIRECTORY,
  "emoji-fingerprint-db.min.json",
);
export const BROWSER_RUNTIME_DATASET_PATH = path.join(
  DATA_DIRECTORY,
  "browser-runtime-dataset.json",
);

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

export function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

export function writeJsonFile(filePath, value, { minified = false } = {}) {
  const serializedValue = minified
    ? JSON.stringify(value)
    : JSON.stringify(value, null, 2);

  fs.writeFileSync(filePath, serializedValue, "utf8");
}

export function listFiles(directoryPath, matcher) {
  if (!fs.existsSync(directoryPath)) {
    return [];
  }

  return fs.readdirSync(directoryPath).filter(matcher);
}

export function normalizeCodepoint(value) {
  return String(value || "")
    .replace(/^U\+/i, "")
    .trim()
    .toUpperCase();
}

export function splitCodepointString(codepointValue) {
  if (Array.isArray(codepointValue)) {
    return codepointValue
      .map((value) => normalizeCodepoint(value))
      .filter(Boolean);
  }

  const normalizedValue = String(codepointValue || "").trim();

  if (!normalizedValue) {
    return [];
  }

  return normalizedValue
    .split(/[\s-]+/)
    .map((value) => normalizeCodepoint(value))
    .filter(Boolean);
}

export function deriveCodepointsFromGlyph(glyphValue) {
  return Array.from(String(glyphValue || "")).map((character) =>
    character.codePointAt(0).toString(16).toUpperCase(),
  );
}

export function createEmojiIdentifier(codepoints) {
  return Array.isArray(codepoints) ? codepoints.join("-") : "";
}

export function isSkinToneCodepoint(codepointValue) {
  return ["1F3FB", "1F3FC", "1F3FD", "1F3FE", "1F3FF"].includes(
    normalizeCodepoint(codepointValue),
  );
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
