import runtimeDataset from "../data/browser-runtime-dataset.json";
import { analyzeFingerprint } from "../src/index.js";
import { createBrowserProbe } from "../src/browser/index.js";

const runProbeButton = document.getElementById("runProbeButton");
const statusLine = document.getElementById("statusLine");
const resultSummary = document.getElementById("resultSummary");
const topMatches = document.getElementById("topMatches");
const unicodeProfile = document.getElementById("unicodeProfile");
const diagnosticsBox = document.getElementById("diagnosticsBox");
const datasetVersionsLabel = document.getElementById("datasetVersionsLabel");
const datasetCandidatesLabel = document.getElementById(
  "datasetCandidatesLabel",
);

const browserProbe = createBrowserProbe({
  tofuClusterOptions: runtimeDataset.defaults?.browser?.tofuCluster,
  supportDetectionOptions: runtimeDataset.defaults?.browser?.supportDetection,
});

function setDatasetMetadata() {
  const coveredVersions = runtimeDataset.metadata?.unicodeVersionsCovered || [];
  const totalCandidates = runtimeDataset.metadata?.totalOsVersions || 0;

  datasetVersionsLabel.textContent = coveredVersions.join(", ");
  datasetCandidatesLabel.textContent = String(totalCandidates);
}

function formatPercentage(probabilityValue) {
  return `${(probabilityValue * 100).toFixed(1)}%`;
}

function renderSummary(analysisResult) {
  const summaryLines = [];

  if (analysisResult.error) {
    summaryLines.push(`error: ${analysisResult.error}`);
  }

  if (analysisResult.unicodeVersion?.version) {
    summaryLines.push(
      `unicode version: ${analysisResult.unicodeVersion.version} (${analysisResult.unicodeVersion.method})`,
    );
  } else {
    summaryLines.push("unicode version: unavailable");
  }

  if (analysisResult.topMatch) {
    summaryLines.push(
      `top match: ${analysisResult.topMatch.vendor} ${analysisResult.topMatch.osVersion} ${formatPercentage(analysisResult.topMatch.probability)}`,
    );
  } else {
    summaryLines.push("top match: unavailable");
  }

  if (analysisResult.warnings?.length) {
    summaryLines.push(`warnings: ${analysisResult.warnings.join(" | ")}`);
  }

  resultSummary.textContent = summaryLines.join("\n");
}

function renderCandidates(analysisResult) {
  if (!analysisResult.candidates?.length) {
    topMatches.className = "candidate-grid empty-state";
    topMatches.textContent = "No candidates available for this run.";
    return;
  }

  topMatches.className = "candidate-grid";
  topMatches.replaceChildren(
    ...analysisResult.candidates.slice(0, 6).map((candidate) => {
      const candidateArticle = document.createElement("article");
      candidateArticle.className = "candidate-card";
      candidateArticle.innerHTML = `
        <p class="candidate-probability">${formatPercentage(candidate.probability)}</p>
        <h3>${candidate.osVersion}</h3>
        <p class="candidate-vendor">${candidate.vendor}</p>
        <dl>
          <div>
            <dt>Max Unicode</dt>
            <dd>${candidate.maxEmojiVersion || "Unknown"}</dd>
          </div>
          <div>
            <dt>Score</dt>
            <dd>${candidate.score}</dd>
          </div>
        </dl>
      `;
      return candidateArticle;
    }),
  );
}

function renderUnicodeProfile(analysisResult) {
  const versions = Object.entries(analysisResult.emojiProfile?.versions || {});

  if (versions.length === 0) {
    unicodeProfile.className = "table-shell empty-state";
    unicodeProfile.textContent = "No sentinel profile is available.";
    return;
  }

  unicodeProfile.className = "table-shell";

  const tableMarkup = `
    <table class="profile-table">
      <thead>
        <tr>
          <th>Unicode</th>
          <th>Passed</th>
          <th>Failed</th>
          <th>Unknown</th>
          <th>Pass ratio</th>
        </tr>
      </thead>
      <tbody>
        ${versions
          .map(
            ([version, stats]) => `
              <tr>
                <td>${version}</td>
                <td>${stats.passed}</td>
                <td>${stats.failed}</td>
                <td>${stats.unknown}</td>
                <td>${stats.passRatio === null ? "n/a" : stats.passRatio.toFixed(2)}</td>
              </tr>
            `,
          )
          .join("")}
      </tbody>
    </table>
  `;

  unicodeProfile.innerHTML = tableMarkup;
}

function renderDiagnostics(analysisResult) {
  diagnosticsBox.textContent = JSON.stringify(
    analysisResult.diagnostics,
    null,
    2,
  );
}

async function runProbe() {
  runProbeButton.disabled = true;
  statusLine.textContent = "Collecting sentinel measurements in the browser.";

  try {
    const fingerprintInput = await browserProbe.run(runtimeDataset);
    const analysisResult = analyzeFingerprint(fingerprintInput, runtimeDataset);

    statusLine.textContent = analysisResult.error
      ? "The probe completed with a reliability warning."
      : "The probe has been completed.";

    renderSummary(analysisResult);
    renderCandidates(analysisResult);
    renderUnicodeProfile(analysisResult);
    renderDiagnostics(analysisResult);
  } catch (error) {
    statusLine.textContent = "The probe failed before analysis could complete.";
    resultSummary.textContent =
      error instanceof Error ? error.message : String(error);
    topMatches.className = "candidate-grid empty-state";
    topMatches.textContent =
      "No candidates available because the probe failed.";
    unicodeProfile.className = "table-shell empty-state";
    unicodeProfile.textContent = "No sentinel profile is available.";
    diagnosticsBox.textContent = "No diagnostics available.";
  } finally {
    runProbeButton.disabled = false;
  }
}

setDatasetMetadata();
runProbeButton.addEventListener("click", runProbe);
