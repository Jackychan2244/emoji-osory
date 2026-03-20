import fs from "fs";
import path from "path";

const repositoryRoot = process.cwd();
const emojiPattern = /\p{Extended_Pictographic}/u;
const includedRoots = [
  ".github",
  "demo",
  "docs",
  "src",
  "scripts",
  "tests",
  "tools",
  "data",
];
const includedFiles = [
  ".editorconfig",
  ".gitignore",
  ".prettierrc.json",
  "CONTRIBUTING.md",
  "LICENSE",
  "README.md",
  "SECURITY.md",
  "eslint.config.js",
  "package.json",
  "sanitize-vendor-data.js",
  "start_scraper.sh",
  "vite.config.js",
];
const excludedPrefixes = [
  "archive/",
  "data/unicode/",
  "dist/",
  "node_modules/",
  "coverage/",
];
const excludedSuffixes = [".min.json"];

function shouldSkip(relativePath) {
  return (
    excludedPrefixes.some((prefix) => relativePath.startsWith(prefix)) ||
    excludedSuffixes.some((suffix) => relativePath.endsWith(suffix))
  );
}

function collectFiles(targetPath, collectedFiles) {
  const absolutePath = path.join(repositoryRoot, targetPath);

  if (!fs.existsSync(absolutePath)) {
    return;
  }

  const stat = fs.statSync(absolutePath);

  if (stat.isFile()) {
    const normalizedPath = targetPath.replace(/\\/g, "/");

    if (!shouldSkip(normalizedPath)) {
      collectedFiles.push(normalizedPath);
    }

    return;
  }

  for (const childName of fs.readdirSync(absolutePath)) {
    collectFiles(path.join(targetPath, childName), collectedFiles);
  }
}

function locateFirstEmoji(contentValue) {
  for (const character of contentValue) {
    if (emojiPattern.test(character)) {
      return character;
    }
  }

  return null;
}

const candidateFiles = [];

for (const includedRoot of includedRoots) {
  collectFiles(includedRoot, candidateFiles);
}

for (const includedFile of includedFiles) {
  collectFiles(includedFile, candidateFiles);
}

const violations = [];

for (const relativePath of [...new Set(candidateFiles)].sort()) {
  const fileContents = fs.readFileSync(
    path.join(repositoryRoot, relativePath),
    "utf8",
  );
  const firstEmoji = locateFirstEmoji(fileContents);

  if (firstEmoji) {
    violations.push({
      path: relativePath,
      codepoint: firstEmoji.codePointAt(0).toString(16).toUpperCase(),
    });
  }
}

if (violations.length > 0) {
  for (const violation of violations) {
    console.error(`${violation.path}: U+${violation.codepoint}`);
  }

  process.exitCode = 1;
} else {
  console.log("no emoji glyphs detected in checked repository paths");
}
