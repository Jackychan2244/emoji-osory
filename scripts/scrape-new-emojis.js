// scrape-new-emojis.js
// Scrape Emojipedia vendor/version `/new` pages with Puppeteer.

import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import puppeteer from "puppeteer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

import { TARGETS, buildBaseUrl, buildNewUrl } from "./targets.js";

const OUTPUT_DIR = path.join(__dirname, "..", "data", "vendors");
const UNICODE_MASTER_PATH = path.join(
  __dirname,
  "..",
  "data",
  "unicode-master.json",
);

const DEFAULTS = {
  concurrency: 1,
  resume: false,
  maxRetries: 5,
  timeoutMs: 60_000,
  headless: true,
  slowMoMs: 0,
  globalFailurePauseThreshold: 6,
};

function compareVersions(a, b) {
  const partsA = String(a || "")
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  const partsB = String(b || "")
    .split(".")
    .map((n) => Number.parseInt(n, 10));
  const length = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < length; i++) {
    const valueA = partsA[i] || 0;
    const valueB = partsB[i] || 0;
    if (valueA > valueB) return 1;
    if (valueA < valueB) return -1;
  }

  return 0;
}

function cleanUnicodeName(rawName) {
  const name = String(rawName || "").trim();
  if (!name) return "";
  return name.replace(/^E\d+(?:\.\d+)?\s+/i, "").trim();
}

function normalizeName(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[_/]+/g, " ")
    .replace(/[-]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function codepointsHex(char) {
  const hex = [];
  for (const segment of String(char || "")) {
    hex.push(segment.codePointAt(0).toString(16).toUpperCase());
  }
  return hex.join("-");
}

function charFromHexSequence(hexSequence) {
  const parts = String(hexSequence || "")
    .split("-")
    .filter(Boolean);
  if (parts.length === 0) return null;

  const codepoints = [];
  for (const part of parts) {
    if (!/^[0-9a-fA-F]+$/.test(part)) return null;
    const value = Number.parseInt(part, 16);
    if (!Number.isFinite(value) || value < 0 || value > 0x10ffff) return null;
    codepoints.push(value);
  }

  try {
    return String.fromCodePoint(...codepoints);
  } catch {
    return null;
  }
}

function extractHexSequenceFromAssetUrl(rawUrl) {
  const value = String(rawUrl || "").trim();
  if (!value) return null;

  let url = value;
  const urlMatch = url.match(/url\\((.+)\\)/i);
  if (urlMatch) {
    url = urlMatch[1].trim().replace(/^['"]|['"]$/g, "");
  }

  const noQuery = url.split("?")[0];
  const file = noQuery.split("/").pop() || "";
  const base = file.replace(/\\.(?:png|webp|svg|jpg)$/i, "");

  // Emojipedia assets sometimes include multiple hex chunks; pick the most specific.
  // Example:
  //   leftwards-pushing-hand_light-skin-tone_1faf7-1f3fb_1f3fb.webp
  // We want 1faf7-1f3fb, not the trailing 1f3fb.
  const matches = [...base.matchAll(/_([0-9a-fA-F]+(?:-[0-9a-fA-F]+)*)/g)].map(
    (m) => m[1],
  );
  if (matches.length === 0) return null;

  matches.sort((a, b) => {
    const partsA = a.split("-").length;
    const partsB = b.split("-").length;
    if (partsA !== partsB) return partsB - partsA;
    return b.length - a.length;
  });

  return matches[0].toUpperCase();
}

function formatTargetLabel(target) {
  return `${target.vendorKey}:${target.os_version}`;
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jitterMs(baseMs, ratio = 0.2) {
  const span = Math.max(1, Math.floor(baseMs * ratio));
  return baseMs + Math.floor((Math.random() * 2 - 1) * span);
}

class PauseController {
  constructor() {
    this.paused = false;
    this.pauseReason = null;
    this.waiters = [];
    this.stopped = false;
  }

  pause(reason) {
    if (this.paused) return;
    this.paused = true;
    this.pauseReason = reason || "paused";
    console.log(`\n[paused] ${this.pauseReason}`);
    console.log('  Press "r" to resume, "q" to quit.\n');
  }

  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.pauseReason = null;
    console.log("\n[resumed]\n");
    const waiters = this.waiters.slice();
    this.waiters.length = 0;
    for (const resolve of waiters) resolve();
  }

  stop(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.pauseReason = reason || "stopped";
    console.log(`\n[stopping] ${this.pauseReason}\n`);
    this.resume();
  }

  async waitIfPaused() {
    if (this.stopped) throw new Error("Stopped");
    if (!this.paused) return;
    await new Promise((resolve) => this.waiters.push(resolve));
    if (this.stopped) throw new Error("Stopped");
  }
}

class VendorStore {
  constructor(vendorKey, outputDir) {
    this.vendorKey = vendorKey;
    this.outputDir = outputDir;
    this.dataPath = path.join(outputDir, `${vendorKey}.json`);
    this.unresolvedPath = path.join(outputDir, `${vendorKey}.unresolved.json`);
    this.entries = [];
    this.unresolvedByOs = {};
    this.writeChain = Promise.resolve();
  }

  load() {
    this.entries = [];
    this.unresolvedByOs = {};

    if (fs.existsSync(this.dataPath)) {
      const raw = fs.readFileSync(this.dataPath, "utf8");
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          this.entries = parsed.filter((entry) => {
            const url = entry && typeof entry === "object" ? entry.url : null;
            return !(typeof url === "string" && url.includes("mock.local"));
          });
        }
      }
    }

    if (fs.existsSync(this.unresolvedPath)) {
      const raw = fs.readFileSync(this.unresolvedPath, "utf8");
      if (raw.trim()) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          this.unresolvedByOs = parsed;
        }
      }
    }
  }

  isResumeComplete(osVersion) {
    const existing = this.entries.find((e) => e && e.os_version === osVersion);
    if (!existing) return false;
    if (existing.scrape_status && existing.scrape_status !== "failed")
      return true;
    if (existing.error) return false;
    if (Array.isArray(existing.emojis)) return true;
    return false;
  }

  enqueueWrite(fn) {
    this.writeChain = this.writeChain.then(fn).catch((error) => {
      console.error(`[${this.vendorKey}] write error:`, error);
    });
    return this.writeChain;
  }

  async upsert(entry, unresolved) {
    await this.enqueueWrite(async () => {
      const existingIndex = this.entries.findIndex(
        (e) => e && e.os_version === entry.os_version,
      );
      if (existingIndex >= 0) {
        this.entries[existingIndex] = entry;
      } else {
        this.entries.push(entry);
      }

      if (Array.isArray(unresolved) && unresolved.length > 0) {
        this.unresolvedByOs[entry.os_version] = {
          url: entry.url,
          new_url: entry.new_url,
          scraped_at: entry.scraped_at,
          unresolved,
        };
      } else {
        delete this.unresolvedByOs[entry.os_version];
      }

      await ensureDir(this.outputDir);
      await writeJsonWithBackup(this.dataPath, this.entries);
      await writeJsonWithBackup(this.unresolvedPath, this.unresolvedByOs);
    });
  }
}

async function ensureDir(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

async function writeJsonWithBackup(filePath, data) {
  const tmpPath = `${filePath}.tmp`;
  const backupPath = `${filePath}.bak`;

  if (fs.existsSync(filePath)) {
    try {
      await fs.promises.copyFile(filePath, backupPath);
    } catch (error) {
      console.error(`Backup failed for ${filePath}:`, error.message);
    }
  }

  await fs.promises.writeFile(tmpPath, JSON.stringify(data, null, 2), "utf8");
  await fs.promises.rename(tmpPath, filePath);
}

function parseArgs(argv) {
  const options = { ...DEFAULTS, vendor: null, only: null };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }

    if (arg === "--resume") {
      options.resume = true;
      continue;
    }
    if (arg === "--no-resume") {
      options.resume = false;
      continue;
    }

    const takeNext = () => {
      const value = argv[i + 1];
      i += 1;
      return value;
    };

    if (arg === "--concurrency")
      options.concurrency = Number.parseInt(takeNext(), 10);
    else if (arg === "--max-retries")
      options.maxRetries = Number.parseInt(takeNext(), 10);
    else if (arg === "--timeout")
      options.timeoutMs = Number.parseInt(takeNext(), 10);
    else if (arg === "--headless")
      options.headless = String(takeNext()).toLowerCase() !== "false";
    else if (arg.startsWith("--headless="))
      options.headless = arg.split("=", 2)[1].toLowerCase() !== "false";
    else if (arg === "--slowmo")
      options.slowMoMs = Number.parseInt(takeNext(), 10);
    else if (arg === "--vendor") options.vendor = takeNext();
    else if (arg === "--only") options.only = takeNext();
    else if (arg.startsWith("--"))
      throw new Error(`Unknown flag: ${arg} (try --help)`);
    else throw new Error(`Unexpected arg: ${arg} (try --help)`);
  }

  if (!Number.isFinite(options.concurrency) || options.concurrency < 1)
    options.concurrency = 1;
  if (!Number.isFinite(options.maxRetries) || options.maxRetries < 0)
    options.maxRetries = DEFAULTS.maxRetries;
  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 1_000)
    options.timeoutMs = DEFAULTS.timeoutMs;
  if (!Number.isFinite(options.slowMoMs) || options.slowMoMs < 0)
    options.slowMoMs = 0;

  return options;
}

function printHelp() {
  console.log(`Usage: node scrape-new-emojis.js [options]

Options:
  --concurrency <n>     Parallel targets (default ${DEFAULTS.concurrency})
  --resume              Skip targets with existing entries
  --no-resume           Disable resume
  --max-retries <n>     Max retries per page (default ${DEFAULTS.maxRetries})
  --timeout <ms>        Navigation timeout (default ${DEFAULTS.timeoutMs})
  --headless[=true|false]  Browser headless mode (default ${DEFAULTS.headless})
  --slowmo <ms>         Puppeteer slowMo (default 0)
  --vendor <keys>       Comma-separated vendorKey filter (e.g., apple_ios,microsoft_windows)
  --only <substr>       Substring match against "vendorKey:os_version"
  --help                Show this help

Controls (interactive TTY):
  p = pause, r = resume, q = quit
`);
}

function loadUnicodeMaster(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Missing ${filePath}. Run: npm run parse`);
  }
  const raw = fs.readFileSync(filePath, "utf8");
  if (!raw.trim()) {
    throw new Error(`${filePath} is empty. Run: npm run parse`);
  }
  return JSON.parse(raw);
}

function buildUnicodeIndex(unicodeMaster) {
  const unicodeVersions =
    unicodeMaster &&
    unicodeMaster.unicode_versions &&
    typeof unicodeMaster.unicode_versions === "object"
      ? unicodeMaster.unicode_versions
      : {};

  const versions = Object.keys(unicodeVersions).sort(compareVersions);
  const emojiByChar = new Map();

  for (const version of versions) {
    const emojis = unicodeVersions[version]?.all_emojis || [];
    for (const emoji of emojis) {
      if (!emoji || typeof emoji.char !== "string" || !emoji.char) continue;
      if (emojiByChar.has(emoji.char)) continue;

      emojiByChar.set(emoji.char, {
        char: emoji.char,
        name: cleanUnicodeName(emoji.name),
        first_version: version,
      });
    }
  }

  const byNormalizedName = new Map();
  for (const [char, info] of emojiByChar.entries()) {
    const norm = normalizeName(info.name);
    if (!norm) continue;
    const existing = byNormalizedName.get(norm);
    if (!existing) {
      byNormalizedName.set(norm, char);
    } else if (existing !== char) {
      byNormalizedName.set(norm, null); // ambiguous
    }
  }

  const segmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

  return { versions, emojiByChar, byNormalizedName, segmenter };
}

function extractEmojiClusters(text, emojiByChar, segmenter) {
  const found = [];
  const seen = new Set();
  const value = String(text || "");
  if (!value) return found;

  for (const part of segmenter.segment(value)) {
    const cluster = part.segment;
    if (!cluster || seen.has(cluster)) continue;
    if (emojiByChar.has(cluster)) {
      seen.add(cluster);
      found.push(cluster);
    }
  }
  return found;
}

function isSoftBlockText(text) {
  const value = String(text || "").toLowerCase();
  return (
    value.includes("just a moment") ||
    value.includes("checking your browser") ||
    value.includes("cloudflare") ||
    value.includes("verify you are human") ||
    value.includes("captcha")
  );
}

async function detectSoftBlock(page) {
  const title = await page.title().catch(() => "");
  if (isSoftBlockText(title))
    return { blocked: true, signal: `title:${title}` };

  const snippet = await page
    .evaluate(() =>
      document.body ? document.body.innerText.slice(0, 1200) : "",
    )
    .catch(() => "");
  if (isSoftBlockText(snippet))
    return { blocked: true, signal: `body:${snippet.slice(0, 80)}` };

  return { blocked: false, signal: null };
}

async function detectNotFound(page) {
  const title = await page.title().catch(() => "");
  const titleLower = String(title || "").toLowerCase();
  if (titleLower.includes("not found") || titleLower.includes("404")) {
    return { notFound: true, signal: `title:${title}` };
  }

  const snippet = await page
    .evaluate(() =>
      document.body ? document.body.innerText.slice(0, 400) : "",
    )
    .catch(() => "");
  const snippetLower = String(snippet || "").toLowerCase();
  if (
    snippetLower.includes("not found") ||
    snippetLower.includes("page not found") ||
    snippetLower.includes("404")
  ) {
    return { notFound: true, signal: `body:${snippet.slice(0, 80)}` };
  }

  return { notFound: false, signal: null };
}

async function detectNoNewEmojis(page) {
  const snippet = await page
    .evaluate(() =>
      document.body ? document.body.innerText.slice(0, 1600) : "",
    )
    .catch(() => "");
  const lower = String(snippet || "").toLowerCase();
  const signals = [
    "no new emoji",
    "no new emojis",
    "no emojis were added",
    "no emojis were released",
  ];
  for (const signal of signals) {
    if (lower.includes(signal)) return { none: true, signal };
  }
  return { none: false, signal: null };
}

async function withRetries(
  taskLabel,
  fn,
  { maxRetries, baseDelayMs = 1_500, pauseController, onFailure },
) {
  let lastError = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    await pauseController.waitIfPaused();
    try {
      return await fn(attempt);
    } catch (error) {
      lastError = error;
      const isLast = attempt >= maxRetries;
      if (typeof onFailure === "function") onFailure(error, attempt, isLast);
      if (isLast) break;

      const delay = jitterMs(baseDelayMs * Math.pow(2, attempt));
      console.log(
        `  ↻ Retry in ${delay}ms (${attempt + 1}/${maxRetries}) [${taskLabel}]: ${error.message}`,
      );
      await sleep(delay);
    }
  }

  throw lastError || new Error("Unknown error");
}

async function configurePage(page, { userAgent, timeoutMs }) {
  await page.setUserAgent(userAgent);
  await page.setViewport({ width: 1280, height: 800 });
  await page.setExtraHTTPHeaders({
    "Accept-Language": "en-US,en;q=0.9",
  });

  await page.setRequestInterception(true);
  page.on("request", (req) => {
    const type = req.resourceType();
    // Emojipedia's emoji list rendering breaks if we block images/stylesheets.
    if (type === "media" || type === "font") {
      req.abort();
    } else {
      req.continue();
    }
  });

  page.setDefaultNavigationTimeout(timeoutMs);
  page.setDefaultTimeout(timeoutMs);
}

async function collectEmojiLinkCandidates(
  page,
  target,
  pauseController,
  timeoutMs,
) {
  const vendorSlug = target.vendorSlug;
  const versionSlug = target.versionSlug;
  const prefix = `/${vendorSlug}/${versionSlug}/`;

  const maxRounds = 20;
  const minRounds = 8;
  let stableRounds = 0;
  let lastCount = 0;
  const candidates = new Map();
  const start = Date.now();

  for (let round = 0; round < maxRounds; round++) {
    await pauseController.waitIfPaused();

    const items = await page.evaluate(
      ({ prefix }) => {
        const out = [];
        const anchors = Array.from(document.querySelectorAll("a[href]"));
        for (const a of anchors) {
          const rawHref = a.getAttribute("href") || "";
          const href = rawHref.startsWith("http")
            ? (() => {
                try {
                  return new URL(rawHref).pathname;
                } catch {
                  return null;
                }
              })()
            : rawHref;

          if (!href || !href.startsWith(prefix)) continue;

          const rest = href.slice(prefix.length);
          const cleanRest = rest.split(/[?#]/)[0].replace(/\/+$/, "");
          if (
            !cleanRest ||
            cleanRest === "new" ||
            cleanRest === "changed" ||
            cleanRest === "removed"
          )
            continue;

          const text = (a.innerText || "").trim();
          const title = (a.getAttribute("title") || "").trim();
          const aria = (a.getAttribute("aria-label") || "").trim();
          const imgAlt = (
            a.querySelector("img")?.getAttribute("alt") || ""
          ).trim();
          const dataSrc = (a.getAttribute("data-src") || "").trim();
          const bgImage = (
            a.style && a.style.backgroundImage ? a.style.backgroundImage : ""
          ).trim();

          out.push({
            href_path: href,
            slug: cleanRest,
            text,
            title,
            aria,
            imgAlt,
            dataSrc,
            bgImage,
          });
        }
        return out;
      },
      { prefix },
    );

    for (const item of items) {
      const existing = candidates.get(item.href_path);
      if (!existing) {
        candidates.set(item.href_path, item);
        continue;
      }

      candidates.set(item.href_path, {
        ...existing,
        // Prefer non-empty fields as the page hydrates/lazy-loads.
        text: existing.text || item.text,
        title: existing.title || item.title,
        aria: existing.aria || item.aria,
        imgAlt: existing.imgAlt || item.imgAlt,
        dataSrc: existing.dataSrc || item.dataSrc,
        bgImage: existing.bgImage || item.bgImage,
      });
    }

    const count = candidates.size;
    if (count === lastCount) stableRounds += 1;
    else stableRounds = 0;
    lastCount = count;

    const elapsed = Date.now() - start;
    if (elapsed > timeoutMs) break;
    if (round >= minRounds && count > 0 && stableRounds >= 2) break;

    const clicked = await page
      .evaluate(() => {
        const buttons = Array.from(document.querySelectorAll("button"));
        const loadMore = buttons.find((btn) =>
          /^(load more|show more)$/i.test((btn.innerText || "").trim()),
        );
        if (!loadMore) return false;
        loadMore.click();
        return true;
      })
      .catch(() => false);

    await page
      .evaluate(() => window.scrollBy(0, window.innerHeight))
      .catch(() => {});
    await sleep(clicked ? 900 : 650);
  }

  // Give the DOM one last chance to settle.
  await sleep(250);

  return [...candidates.values()];
}

function resolveFromCandidates(item, unicodeIndex) {
  const { emojiByChar, segmenter } = unicodeIndex;
  const assetUrls = [item.dataSrc, item.bgImage].filter(Boolean);
  for (const assetUrl of assetUrls) {
    const hexSeq = extractHexSequenceFromAssetUrl(assetUrl);
    if (!hexSeq) continue;
    const char = charFromHexSequence(hexSeq);
    if (char && emojiByChar.has(char)) {
      return { char, source_method: "dom_char", confidence: "high" };
    }
  }

  const strings = [item.text, item.aria, item.title, item.imgAlt].filter(
    Boolean,
  );

  for (const value of strings) {
    const clusters = extractEmojiClusters(value, emojiByChar, segmenter);
    if (clusters.length > 0) {
      return {
        char: clusters[0],
        source_method: "dom_char",
        confidence: "high",
      };
    }
  }

  return null;
}

function resolveFromSlug(slug, unicodeIndex) {
  const norm = normalizeName(slug);
  if (!norm) return null;

  const direct = unicodeIndex.byNormalizedName.get(norm);
  if (direct === null) return null;
  if (typeof direct === "string") {
    return { char: direct, source_method: "slug_lookup", confidence: "low" };
  }

  // Fuzzy: require all tokens to be present.
  const tokens = norm.split(" ").filter(Boolean);
  if (tokens.length === 0) return null;

  let best = null;
  let bestScore = -1;
  let bestAmbiguous = false;

  for (const [char, info] of unicodeIndex.emojiByChar.entries()) {
    const nameNorm = normalizeName(info.name);
    if (!nameNorm) continue;
    const nameTokens = new Set(nameNorm.split(" ").filter(Boolean));

    let matched = 0;
    for (const token of tokens) {
      if (nameTokens.has(token)) matched += 1;
    }

    if (matched !== tokens.length) continue;

    const extra = nameTokens.size - tokens.length;
    const score = matched * 10 - extra;
    if (score > bestScore) {
      bestScore = score;
      best = char;
      bestAmbiguous = false;
    } else if (score === bestScore) {
      bestAmbiguous = true;
    }
  }

  if (!best || bestAmbiguous) return null;
  return { char: best, source_method: "slug_lookup", confidence: "low" };
}

async function resolveViaEmojiPage(
  browser,
  hrefPath,
  unicodeIndex,
  pauseController,
  config,
) {
  const url = `https://emojipedia.org${hrefPath}`;
  const page = await browser.newPage();
  try {
    await configurePage(page, config);
    await pauseController.waitIfPaused();
    await page.goto(url, { waitUntil: "domcontentloaded" });

    const block = await detectSoftBlock(page);
    if (block.blocked) {
      pauseController.pause(
        `Soft block detected on emoji page: ${block.signal}`,
      );
      await pauseController.waitIfPaused();
      return null;
    }

    const payload = await page.evaluate(() => {
      const og =
        document
          .querySelector('meta[property="og:title"]')
          ?.getAttribute("content") || "";
      const h1 = document.querySelector("h1")?.innerText || "";
      return {
        title: document.title || "",
        og,
        h1,
      };
    });

    const strings = [payload.og, payload.h1, payload.title].filter(Boolean);
    for (const value of strings) {
      const clusters = extractEmojiClusters(
        value,
        unicodeIndex.emojiByChar,
        unicodeIndex.segmenter,
      );
      if (clusters.length > 0) {
        return {
          char: clusters[0],
          source_method: "page_visit",
          confidence: "high",
        };
      }
    }

    return null;
  } finally {
    await page.close().catch(() => {});
  }
}

function inferMaxUnicodeVersion(emojiRecords) {
  let max = null;
  for (const rec of emojiRecords) {
    if (!rec || typeof rec.unicode_version !== "string") continue;
    if (!max || compareVersions(rec.unicode_version, max) > 0)
      max = rec.unicode_version;
  }
  return max;
}

async function scrapeTarget(
  browser,
  target,
  unicodeIndex,
  pauseController,
  config,
) {
  const label = formatTargetLabel(target);
  const baseUrl = buildBaseUrl(target);
  const newUrl = buildNewUrl(target);

  const page = await browser.newPage();
  try {
    await configurePage(page, config);

    console.log(`\n→ Fetch [${label}]: ${newUrl}`);

    const response = await withRetries(
      label,
      async () => {
        const resp = await page.goto(newUrl, { waitUntil: "domcontentloaded" });
        const status = resp?.status?.() ?? null;
        if (status === 404) return resp || null;

        const block = await detectSoftBlock(page);
        if (block.blocked) {
          pauseController.pause(
            `Soft block detected on target page: ${block.signal}`,
          );
          throw new Error("SOFT_BLOCK");
        }

        return resp || null;
      },
      {
        maxRetries: config.maxRetries,
        pauseController,
        onFailure: (error, attempt, isLast) => {
          if (isLast)
            console.error(
              `  ✗ Fail [${label}] after retries: ${error.message}`,
            );
        },
      },
    );

    const status = response?.status?.() ?? null;
    if (status === 404) {
      console.log(`  ↷ Skip [${label}]: /new not found (404)`);
      return {
        entry: {
          url: baseUrl,
          new_url: newUrl,
          vendor: target.vendorKey,
          os_version: target.os_version,
          release_date: target.release_date,
          emoji_versions_mentioned: [],
          max_emoji_version: null,
          emojis_found: 0,
          emojis: [],
          unresolved_count: 0,
          error: "NO_NEW_PAGE",
          scrape_status: "skipped_no_new_page",
          scraped_at: nowIso(),
        },
        unresolved: [],
      };
    }

    // Give the app time to fetch/render. If there are genuinely no new emojis, we still proceed.
    await page
      .waitForFunction(
        (vendorSlug, versionSlug) => {
          const prefix = `/${vendorSlug}/${versionSlug}/`;
          return Array.from(document.querySelectorAll("a[href]")).some((a) => {
            const raw = a.getAttribute("href") || "";
            const href = raw.startsWith("http")
              ? (() => {
                  try {
                    return new URL(raw).pathname;
                  } catch {
                    return null;
                  }
                })()
              : raw;
            if (!href || !href.startsWith(prefix)) return false;
            const rest = href
              .slice(prefix.length)
              .split(/[?#]/)[0]
              .replace(/\/+$/, "");
            return rest && rest !== "new" && rest !== "changed";
          });
        },
        { timeout: Math.min(20_000, config.timeoutMs) },
        target.vendorSlug,
        target.versionSlug,
      )
      .catch(() => {});

    const candidates = await collectEmojiLinkCandidates(
      page,
      target,
      pauseController,
      config.timeoutMs,
    );
    if (candidates.length === 0) {
      const notFound = await detectNotFound(page);
      if (notFound.notFound) {
        console.log(`  ↷ Skip [${label}]: /new not found (${notFound.signal})`);
        return {
          entry: {
            url: baseUrl,
            new_url: newUrl,
            vendor: target.vendorKey,
            os_version: target.os_version,
            release_date: target.release_date,
            emoji_versions_mentioned: [],
            max_emoji_version: null,
            emojis_found: 0,
            emojis: [],
            unresolved_count: 0,
            error: "NO_NEW_PAGE",
            scrape_status: "skipped_no_new_page",
            scraped_at: nowIso(),
          },
          unresolved: [],
        };
      }

      const none = await detectNoNewEmojis(page);
      if (none.none) {
        console.log(`  ✓ Done [${label}]: 0 emojis (${none.signal})`);
        return {
          entry: {
            url: baseUrl,
            new_url: newUrl,
            vendor: target.vendorKey,
            os_version: target.os_version,
            release_date: target.release_date,
            emoji_versions_mentioned: [],
            max_emoji_version: null,
            emojis_found: 0,
            emojis: [],
            unresolved_count: 0,
            scrape_status: "success",
            scraped_at: nowIso(),
          },
          unresolved: [],
        };
      }

      console.log(`  ✗ Fail [${label}]: no emoji links found`);
      return {
        entry: {
          url: baseUrl,
          new_url: newUrl,
          vendor: target.vendorKey,
          os_version: target.os_version,
          release_date: target.release_date,
          emoji_versions_mentioned: [],
          max_emoji_version: null,
          emojis_found: 0,
          emojis: [],
          unresolved_count: 0,
          error: "NO_EMOJI_LINKS_FOUND",
          scrape_status: "failed",
          scraped_at: nowIso(),
        },
        unresolved: [],
      };
    }

    const emojis = [];
    const unresolved = [];
    const seenChars = new Set();

    for (const item of candidates) {
      await pauseController.waitIfPaused();
      if (pauseController.stopped) break;

      let resolved = resolveFromCandidates(item, unicodeIndex);
      if (!resolved) {
        resolved = await resolveViaEmojiPage(
          browser,
          item.href_path,
          unicodeIndex,
          pauseController,
          config,
        );
      }
      if (!resolved) {
        resolved = resolveFromSlug(item.slug, unicodeIndex);
      }

      if (
        !resolved ||
        !resolved.char ||
        !unicodeIndex.emojiByChar.has(resolved.char)
      ) {
        const assetHex =
          extractHexSequenceFromAssetUrl(item.dataSrc) ||
          extractHexSequenceFromAssetUrl(item.bgImage);
        const assetChar = assetHex ? charFromHexSequence(assetHex) : null;
        unresolved.push({
          href_path: item.href_path,
          slug: item.slug,
          reason: "UNRESOLVED",
          text: item.text || null,
          title: item.title || null,
          aria: item.aria || null,
          imgAlt: item.imgAlt || null,
          dataSrc: item.dataSrc || null,
          bgImage: item.bgImage || null,
          asset_hex: assetHex,
          asset_char: assetChar,
        });
        continue;
      }

      if (seenChars.has(resolved.char)) continue;
      seenChars.add(resolved.char);

      const meta = unicodeIndex.emojiByChar.get(resolved.char);
      emojis.push({
        char: resolved.char,
        codepoints: codepointsHex(resolved.char),
        name: meta?.name || item.slug,
        unicode_version: meta?.first_version || null,
        source_method: resolved.source_method,
        confidence: resolved.confidence,
        source_url: `https://emojipedia.org${item.href_path}`,
      });
    }

    const maxUnicodeVersion = inferMaxUnicodeVersion(emojis);
    const statusLabel =
      unresolved.length > 0 ? "success_with_unresolved" : "success";

    console.log(
      `  ✓ Done [${label}]: ${emojis.length} emojis (${unresolved.length} unresolved)`,
    );

    return {
      entry: {
        url: baseUrl,
        new_url: newUrl,
        vendor: target.vendorKey,
        os_version: target.os_version,
        release_date: target.release_date,
        emoji_versions_mentioned: [],
        max_emoji_version: maxUnicodeVersion,
        emojis_found: emojis.length,
        emojis,
        unresolved_count: unresolved.length,
        scrape_status: statusLabel,
        scraped_at: nowIso(),
      },
      unresolved,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runWithConcurrency(items, limit, handler) {
  const results = [];
  let index = 0;
  const executing = new Set();

  async function enqueue() {
    if (index >= items.length) return;
    const item = items[index++];
    const promise = Promise.resolve()
      .then(() => handler(item))
      .then((result) => results.push(result))
      .catch((error) => results.push({ error }));

    executing.add(promise);
    promise.finally(() => executing.delete(promise));

    if (executing.size >= limit) {
      await Promise.race(executing);
    }

    return enqueue();
  }

  await enqueue();
  await Promise.all(executing);
  return results;
}

function setupStdinControls(pauseController) {
  if (!process.stdin.isTTY) return;

  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", (chunk) => {
    const key = chunk.toString("utf8");
    if (key === "p") pauseController.pause("manual");
    if (key === "r") pauseController.resume();
    if (key === "q") pauseController.stop("manual quit");
    if (key === "\u0003") {
      // Ctrl+C raw mode
      console.log("\n[stopping] force quitting (SIGINT)...");
      process.exit(130);
    }
  });

  process.on("SIGINT", () => {
    console.log("\n[stopping] force quitting (SIGINT)...");
    process.exit(130);
  });

  console.log("Controls: p=pause, r=resume, q=quit");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const pauseController = new PauseController();
  setupStdinControls(pauseController);

  const unicodeMaster = loadUnicodeMaster(UNICODE_MASTER_PATH);
  const unicodeIndex = buildUnicodeIndex(unicodeMaster);

  const userAgent =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
  const config = {
    userAgent,
    timeoutMs: options.timeoutMs,
    maxRetries: options.maxRetries,
  };

  const vendorFilter = options.vendor
    ? new Set(
        String(options.vendor)
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean),
      )
    : null;

  const onlySubstr = options.only ? String(options.only).toLowerCase() : null;

  const targets = TARGETS.filter((t) => {
    if (vendorFilter && !vendorFilter.has(t.vendorKey)) return false;
    if (onlySubstr && !formatTargetLabel(t).toLowerCase().includes(onlySubstr))
      return false;
    return true;
  });

  if (targets.length === 0) {
    console.log("No targets matched filters.");
    return;
  }

  const vendorKeys = [...new Set(targets.map((t) => t.vendorKey))];
  const stores = new Map();
  await ensureDir(OUTPUT_DIR);
  for (const vendorKey of vendorKeys) {
    const store = new VendorStore(vendorKey, OUTPUT_DIR);
    store.load();
    stores.set(vendorKey, store);
  }

  console.log(
    `\nTargets: ${targets.length} | concurrency=${options.concurrency} | resume=${options.resume} | headless=${options.headless}`,
  );

  let browser = null;
  let globalFailures = 0;

  try {
    browser = await puppeteer.launch({
      headless: options.headless,
      slowMo: options.slowMoMs || 0,
      args: ["--no-default-browser-check", "--disable-dev-shm-usage"],
    });

    await runWithConcurrency(targets, options.concurrency, async (target) => {
      if (pauseController.stopped) return;
      await pauseController.waitIfPaused();

      const store = stores.get(target.vendorKey);
      const label = formatTargetLabel(target);
      if (
        options.resume &&
        store &&
        store.isResumeComplete(target.os_version)
      ) {
        console.log(`\n↷ Resume-skip [${label}]`);
        return;
      }

      try {
        const { entry, unresolved } = await scrapeTarget(
          browser,
          target,
          unicodeIndex,
          pauseController,
          config,
        );
        await store.upsert(entry, unresolved);

        if (entry.scrape_status === "failed") {
          globalFailures += 1;
        } else {
          globalFailures = 0;
        }

        if (
          globalFailures >= DEFAULTS.globalFailurePauseThreshold &&
          !pauseController.paused
        ) {
          pauseController.pause(
            `Circuit breaker: ${globalFailures} consecutive failures`,
          );
        }
      } catch (error) {
        globalFailures += 1;
        console.error(`\n✗ Fatal target error [${label}]: ${error.message}`);
        if (
          globalFailures >= DEFAULTS.globalFailurePauseThreshold &&
          !pauseController.paused
        ) {
          pauseController.pause(
            `Circuit breaker: ${globalFailures} consecutive failures`,
          );
        }
      }
    });
  } finally {
    if (browser) {
      await browser.close().catch(() => {});
    }
  }

  console.log("\n✓ Scrape run complete.");
}

main().catch((error) => {
  console.error("\n✗ Fatal:", error);
  process.exitCode = 1;
});
