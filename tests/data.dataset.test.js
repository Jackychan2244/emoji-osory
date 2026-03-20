import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { buildMasterDatabase } from "../src/data-build/build-master-database.js";

const repositoryRoot = process.cwd();

function readJson(relativePath) {
  return JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, relativePath), "utf8"),
  );
}

function containsEmojiGlyph(value) {
  return /\p{Extended_Pictographic}/u.test(value);
}

function omitGeneratedTimestamp(value) {
  const rest = { ...value };
  delete rest.generated;
  return rest;
}

describe("dataset outputs", () => {
  it("rebuilds the committed browser dataset deterministically", () => {
    const committedDataset = readJson("data/browser-runtime-dataset.json");
    const generatedDataset = buildMasterDatabase().browserRuntimeDataset;

    expect(omitGeneratedTimestamp(generatedDataset)).toEqual(
      omitGeneratedTimestamp(committedDataset),
    );
  });

  it("rebuilds the committed full database deterministically", () => {
    const committedDatabase = readJson("data/emoji-fingerprint-db.json");
    const generatedDatabase = buildMasterDatabase().fullDatabase;

    expect(omitGeneratedTimestamp(generatedDatabase)).toEqual(
      omitGeneratedTimestamp(committedDatabase),
    );
  });

  it("keeps active committed json outputs free of raw emoji glyphs", () => {
    const checkedFiles = [
      "data/browser-runtime-dataset.json",
      "data/emoji-fingerprint-db.json",
      "data/unicode-master.json",
      ...fs
        .readdirSync(path.join(repositoryRoot, "data", "vendors"))
        .filter((fileName) => fileName.endsWith(".json"))
        .map((fileName) => `data/vendors/${fileName}`),
    ];

    for (const checkedFile of checkedFiles) {
      expect(
        containsEmojiGlyph(
          fs.readFileSync(path.join(repositoryRoot, checkedFile), "utf8"),
        ),
      ).toBe(false);
    }
  });

  it("keeps the runtime dataset complete enough for the browser demo", () => {
    const runtimeDataset = readJson("data/browser-runtime-dataset.json");

    expect(Object.keys(runtimeDataset.sentinels).length).toBeGreaterThan(0);
    expect(
      runtimeDataset.unicodeVersions["15.0"].sentinelIds.length,
    ).toBeGreaterThan(0);
    expect(runtimeDataset.osCandidatesByUnicode["15.0"].length).toBeGreaterThan(
      0,
    );
  });
});
