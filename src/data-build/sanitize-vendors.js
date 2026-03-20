import fs from "fs";
import path from "path";
import {
  VENDOR_DATA_DIRECTORY,
  createEmojiIdentifier,
  deriveCodepointsFromGlyph,
  isPlainObject,
  listFiles,
  splitCodepointString,
  writeJsonFile,
} from "./shared.js";

function isVendorFile(fileName) {
  return (
    fileName.endsWith(".json") &&
    !fileName.endsWith(".bak") &&
    !fileName.endsWith(".tmp") &&
    !fileName.endsWith(".unresolved.json")
  );
}

function isUnresolvedVendorFile(fileName) {
  return (
    fileName.endsWith(".unresolved.json") &&
    !fileName.endsWith(".bak") &&
    !fileName.endsWith(".tmp")
  );
}

function normalizeVendorEmoji(emojiRecord) {
  if (!isPlainObject(emojiRecord)) {
    return null;
  }

  const codepointsFromField = splitCodepointString(emojiRecord.codepoints);
  const codepoints =
    codepointsFromField.length > 0
      ? codepointsFromField
      : deriveCodepointsFromGlyph(emojiRecord.char);

  if (codepoints.length === 0) {
    return null;
  }

  return {
    id: createEmojiIdentifier(codepoints),
    codepoints,
    name: emojiRecord.name || null,
    unicodeVersion:
      emojiRecord.unicodeVersion || emojiRecord.unicode_version || null,
    sourceMethod:
      emojiRecord.sourceMethod || emojiRecord.source_method || "unknown",
    confidence: emojiRecord.confidence || "unknown",
    sourceUrl: emojiRecord.sourceUrl || emojiRecord.source_url || null,
  };
}

function normalizeVendorEntry(entryRecord) {
  if (!isPlainObject(entryRecord)) {
    return null;
  }

  if (entryRecord.error) {
    return {
      vendor: entryRecord.vendor || null,
      osVersion: entryRecord.osVersion || entryRecord.os_version || null,
      releaseDate: entryRecord.releaseDate || entryRecord.release_date || null,
      maxEmojiVersion:
        entryRecord.maxEmojiVersion || entryRecord.max_emoji_version || null,
      sourceUrl: entryRecord.sourceUrl || entryRecord.url || null,
      error: entryRecord.error,
    };
  }

  const normalizedEmojis = Array.isArray(entryRecord.emojis)
    ? entryRecord.emojis
        .map((emojiRecord) => normalizeVendorEmoji(emojiRecord))
        .filter(Boolean)
    : [];

  return {
    vendor: entryRecord.vendor || null,
    osVersion: entryRecord.osVersion || entryRecord.os_version || null,
    releaseDate: entryRecord.releaseDate || entryRecord.release_date || null,
    maxEmojiVersion:
      entryRecord.maxEmojiVersion || entryRecord.max_emoji_version || null,
    emojiVersionsMentioned: Array.isArray(
      entryRecord.emojiVersionsMentioned ||
        entryRecord.emoji_versions_mentioned,
    )
      ? [
          ...(entryRecord.emojiVersionsMentioned ||
            entryRecord.emoji_versions_mentioned),
        ]
      : [],
    emojisFound: normalizedEmojis.length,
    emojis: normalizedEmojis,
    sourceUrl: entryRecord.sourceUrl || entryRecord.url || null,
    unresolvedCount:
      typeof entryRecord.unresolvedCount === "number"
        ? entryRecord.unresolvedCount
        : typeof entryRecord.unresolved_count === "number"
          ? Math.max(0, entryRecord.unresolved_count)
          : undefined,
    isGenerated: Boolean(entryRecord.isGenerated || entryRecord.is_generated),
  };
}

export function sanitizeVendorDirectory() {
  const vendorFiles = listFiles(VENDOR_DATA_DIRECTORY, isVendorFile);

  for (const vendorFile of vendorFiles) {
    const vendorFilePath = path.join(VENDOR_DATA_DIRECTORY, vendorFile);
    const vendorFileContents = JSON.parse(
      fs.readFileSync(vendorFilePath, "utf8"),
    );

    if (!Array.isArray(vendorFileContents)) {
      continue;
    }

    const normalizedEntries = vendorFileContents
      .map((entryRecord) => normalizeVendorEntry(entryRecord))
      .filter(Boolean);

    writeJsonFile(vendorFilePath, normalizedEntries);
  }

  const unresolvedFiles = listFiles(
    VENDOR_DATA_DIRECTORY,
    isUnresolvedVendorFile,
  );

  for (const unresolvedFile of unresolvedFiles) {
    const unresolvedFilePath = path.join(VENDOR_DATA_DIRECTORY, unresolvedFile);
    const unresolvedPayload = JSON.parse(
      fs.readFileSync(unresolvedFilePath, "utf8"),
    );

    if (!isPlainObject(unresolvedPayload)) {
      continue;
    }

    const normalizedPayload = {};

    for (const [osVersion, unresolvedRecord] of Object.entries(
      unresolvedPayload,
    )) {
      const unresolvedEntries = Array.isArray(unresolvedRecord?.unresolved)
        ? unresolvedRecord.unresolved.map((entryRecord) => {
            if (!isPlainObject(entryRecord)) {
              return entryRecord;
            }

            const assetCodepoints = splitCodepointString(entryRecord.asset_hex);
            const rest = { ...entryRecord };
            delete rest.asset_char;

            return assetCodepoints.length > 0
              ? { ...rest, assetCodepoints }
              : rest;
          })
        : [];

      normalizedPayload[osVersion] = {
        ...unresolvedRecord,
        unresolved: unresolvedEntries,
      };
    }

    writeJsonFile(unresolvedFilePath, normalizedPayload);
  }
}

export async function main() {
  sanitizeVendorDirectory();
  console.log(`vendor data sanitized in ${VENDOR_DATA_DIRECTORY}`);
}
