import fs from "fs";
import path from "path";
import {
  UNICODE_MASTER_PATH,
  UNICODE_SOURCE_DIRECTORY,
  createEmojiIdentifier,
  isSkinToneCodepoint,
  listFiles,
  sortVersions,
  splitCodepointString,
  writeJsonFile,
} from "./shared.js";

function parseEmojiDescriptor(descriptorValue, unicodeVersion) {
  const trimmedDescriptor = descriptorValue.trim();
  const match = trimmedDescriptor.match(/^\S+\s+(?:E\d+\.\d+\s+)?(.+)$/);

  return {
    unicodeVersion,
    name: match ? match[1].trim() : trimmedDescriptor,
  };
}

function parseUnicodeVersionFile(filePath, unicodeVersion) {
  const fileContents = fs.readFileSync(filePath, "utf8");
  const fileLines = fileContents.split(/\r?\n/);
  const emojiRecords = [];
  let currentGroup = null;
  let currentSubgroup = null;

  for (const fileLine of fileLines) {
    const trimmedLine = fileLine.trim();

    if (!trimmedLine) {
      continue;
    }

    if (trimmedLine.startsWith("# group:")) {
      currentGroup = trimmedLine.replace("# group:", "").trim();
      continue;
    }

    if (trimmedLine.startsWith("# subgroup:")) {
      currentSubgroup = trimmedLine.replace("# subgroup:", "").trim();
      continue;
    }

    if (trimmedLine.startsWith("#")) {
      continue;
    }

    const match = trimmedLine.match(
      /^([0-9A-F ]+)\s*;\s*([a-z-]+)\s*#\s*(.+)$/i,
    );

    if (!match) {
      continue;
    }

    const [, rawCodepoints, qualificationStatus, descriptor] = match;
    const codepoints = splitCodepointString(rawCodepoints);
    const emojiDescriptor = parseEmojiDescriptor(descriptor, unicodeVersion);

    emojiRecords.push({
      id: createEmojiIdentifier(codepoints),
      codepoints,
      name: emojiDescriptor.name,
      unicodeVersion: emojiDescriptor.unicodeVersion,
      qualificationStatus,
      group: currentGroup,
      subgroup: currentSubgroup,
      isZwJSequence: codepoints.includes("200D"),
      isSkinToneSequence: codepoints.some((codepoint) =>
        isSkinToneCodepoint(codepoint),
      ),
    });
  }

  return emojiRecords;
}

function selectSentinels(unicodeVersions) {
  const seenEmojiIdentifiers = new Set();
  const sentinelsByVersion = {};
  const orderedVersions = sortVersions(Object.keys(unicodeVersions));

  for (const unicodeVersion of orderedVersions) {
    const emojiRecords = unicodeVersions[unicodeVersion].allEmojis;
    const eligibleSentinels = emojiRecords.filter(
      (emojiRecord) =>
        emojiRecord.qualificationStatus === "fully-qualified" &&
        !emojiRecord.isZwJSequence &&
        !emojiRecord.isSkinToneSequence &&
        emojiRecord.codepoints.length === 1 &&
        !seenEmojiIdentifiers.has(emojiRecord.id),
    );
    const availableGroups = [
      ...new Set(eligibleSentinels.map((emoji) => emoji.group)),
    ];
    const selectedSentinels = [];
    const selectedSentinelIdentifiers = new Set();
    const perGroupTarget =
      availableGroups.length === 0 ? 0 : Math.ceil(10 / availableGroups.length);

    for (const groupName of availableGroups) {
      const groupEmojis = eligibleSentinels.filter(
        (emojiRecord) => emojiRecord.group === groupName,
      );
      const step = Math.max(1, Math.floor(groupEmojis.length / perGroupTarget));

      for (
        let index = 0;
        index < groupEmojis.length && selectedSentinels.length < 10;
        index += step
      ) {
        const candidateEmoji = groupEmojis[index];

        if (!selectedSentinelIdentifiers.has(candidateEmoji.id)) {
          selectedSentinels.push(candidateEmoji);
          selectedSentinelIdentifiers.add(candidateEmoji.id);
        }
      }
    }

    if (selectedSentinels.length < 10) {
      for (const candidateEmoji of eligibleSentinels) {
        if (selectedSentinels.length >= 10) {
          break;
        }

        if (!selectedSentinelIdentifiers.has(candidateEmoji.id)) {
          selectedSentinels.push(candidateEmoji);
          selectedSentinelIdentifiers.add(candidateEmoji.id);
        }
      }
    }

    sentinelsByVersion[unicodeVersion] = selectedSentinels;

    for (const emojiRecord of emojiRecords) {
      seenEmojiIdentifiers.add(emojiRecord.id);
    }
  }

  return sentinelsByVersion;
}

export function buildUnicodeMasterDatabase() {
  const unicodeFiles = listFiles(UNICODE_SOURCE_DIRECTORY, (fileName) =>
    /^emoji-test-\d+\.\d+\.txt$/i.test(fileName),
  );
  const discoveredVersions = sortVersions(
    unicodeFiles.map((fileName) =>
      path.basename(fileName, ".txt").replace("emoji-test-", ""),
    ),
  );
  const unicodeVersions = {};

  for (const unicodeVersion of discoveredVersions) {
    const filePath = path.join(
      UNICODE_SOURCE_DIRECTORY,
      `emoji-test-${unicodeVersion}.txt`,
    );
    const emojiRecords = parseUnicodeVersionFile(filePath, unicodeVersion);

    unicodeVersions[unicodeVersion] = {
      releaseDate: null,
      fullEmojiCount: emojiRecords.length,
      sentinelEmojis: [],
      allEmojis: emojiRecords,
    };
  }

  const sentinelsByVersion = selectSentinels(unicodeVersions);

  for (const [unicodeVersion, sentinelRecords] of Object.entries(
    sentinelsByVersion,
  )) {
    unicodeVersions[unicodeVersion].sentinelEmojis = sentinelRecords;
  }

  return {
    version: "2.0.0",
    generated: new Date().toISOString(),
    unicodeVersions,
  };
}

export function main() {
  const unicodeMasterDatabase = buildUnicodeMasterDatabase();
  writeJsonFile(UNICODE_MASTER_PATH, unicodeMasterDatabase);
  console.log(`unicode master written to ${UNICODE_MASTER_PATH}`);
}
