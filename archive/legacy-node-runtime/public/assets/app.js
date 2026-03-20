(function () {
  const API_BASE = location.protocol === 'file:' ? 'http://localhost:3003' : '';
  const CANVAS_SIZE = 50;
  const EMOJI_SIZE = 32;

  let sessionId = null;
  let renderer = null;
  let lastTofuCluster = null;
  let runtimeConfig = null;

  async function loadRuntimeConfig() {
    runtimeConfig = null;
    try {
      const response = await fetch(`${API_BASE}/api/config`, { cache: 'no-store' });
      if (!response.ok || response.status === 204) return null;
      const contentType = response.headers.get('content-type') || '';
      if (!contentType.includes('application/json')) return null;
      runtimeConfig = await response.json();
      applyUiConfig();
    } catch {
      runtimeConfig = null;
    }
    return runtimeConfig;
  }

  function applyUiConfig() {
    const ui = runtimeConfig && runtimeConfig.client && runtimeConfig.client.ui
      ? runtimeConfig.client.ui
      : {};

    const showCandidates = ui.show_candidates !== false;
    const showSentinelProfile = ui.show_sentinel_profile !== false;
    const showDiagnostics = ui.show_diagnostics !== false;

    const candidatesSection = document.getElementById('candidatesList')?.closest('.result-section');
    if (candidatesSection) candidatesSection.style.display = showCandidates ? '' : 'none';

    const sentinelSection = document.getElementById('sentinelProfile')?.closest('.result-section');
    if (sentinelSection) sentinelSection.style.display = showSentinelProfile ? '' : 'none';

    const diagnosticsSection = document.getElementById('diagnostics')?.closest('.result-section');
    if (diagnosticsSection) diagnosticsSection.style.display = showDiagnostics ? '' : 'none';
  }

  function getTofuClusterConfig() {
    const guard = runtimeConfig && runtimeConfig.analysis && runtimeConfig.analysis.guards
      ? runtimeConfig.analysis.guards.tofu_cluster
      : null;
    const client = runtimeConfig && runtimeConfig.client && runtimeConfig.client.tofu_cluster
      ? runtimeConfig.client.tofu_cluster
      : null;

    return {
      enabled: client ? client.enabled !== false : true,
      applyCorrection: client ? client.apply_correction !== false : true,
      minConsideredTrue: guard && typeof guard.min_considered_true === 'number' ? guard.min_considered_true : 12,
      minDominantCount: guard && typeof guard.min_dominant_count === 'number' ? guard.min_dominant_count : 8,
      minShare: guard && typeof guard.min_share === 'number' ? guard.min_share : 0.25
    };
  }

  function buildSessionId() {
    if (window.crypto && typeof crypto.randomUUID === 'function') {
      return `fp_${crypto.randomUUID()}`;
    }
    return `fp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  }

  function collectDiagnostics() {
    const diagnostics = {
      user_agent: navigator.userAgent,
      canvas_blocked: Boolean(renderer && renderer.blocked),
      spoofing_detected: Boolean(renderer && renderer.spoofing),
      tofu_cluster: lastTofuCluster,
      tofu_baseline_hashes: renderer && Array.isArray(renderer.baselineHashes) ? renderer.baselineHashes : []
    };

    if (navigator.userAgentData) {
      diagnostics.user_agent_data = {
        brands: navigator.userAgentData.brands,
        mobile: navigator.userAgentData.mobile,
        platform: navigator.userAgentData.platform
      };
    }

    return diagnostics;
  }

  function createEmojiRenderer() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    canvas.width = CANVAS_SIZE;
    canvas.height = CANVAS_SIZE;

    if (!ctx) {
      const err = new Error('Canvas 2D context unavailable');
      return {
        testEmoji: function () { return null; },
        measureEmoji: function () { return { hash: 0, nonZero: 0, error: err }; },
        isBaselineHash: function () { return true; },
        baselineHashes: [],
        blocked: true,
        spoofing: false
      };
    }

    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    ctx.font = `${EMOJI_SIZE}px Arial, sans-serif`;
    ctx.fillStyle = '#000';

    function renderHash(char) {
      try {
        ctx.clearRect(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        ctx.fillText(char, CANVAS_SIZE / 2, CANVAS_SIZE / 2);
        const imageData = ctx.getImageData(0, 0, CANVAS_SIZE, CANVAS_SIZE);
        const data = imageData.data;

        let hash = 2166136261;
        let nonZero = 0;

        for (let i = 0; i < data.length; i++) {
          hash ^= data[i];
          hash = Math.imul(hash, 16777619);
          if ((i & 3) === 3 && data[i] !== 0) {
            nonZero += 1;
          }
        }

        return { hash: hash >>> 0, nonZero: nonZero };
      } catch (error) {
        return { hash: 0, nonZero: 0, error: error };
      }
    }

    let unstable = false;
    const stabilityBase = '\uFFFF';
    const initialRead = renderHash(stabilityBase);

    if (initialRead.error) {
      const err = new Error('Canvas readback blocked');
      return {
        testEmoji: function () { return null; },
        measureEmoji: function () { return { hash: 0, nonZero: 0, error: err }; },
        isBaselineHash: function () { return true; },
        baselineHashes: [],
        blocked: true,
        spoofing: false
      };
    }

    for (let i = 0; i < 5; i++) {
      const check = renderHash(stabilityBase);
      if (check.error) {
        const err = new Error('Canvas readback blocked');
        return {
          testEmoji: function () { return null; },
          measureEmoji: function () { return { hash: 0, nonZero: 0, error: err }; },
          isBaselineHash: function () { return true; },
          baselineHashes: [],
          blocked: true,
          spoofing: false
        };
      }
      if (check.hash !== initialRead.hash) {
        unstable = true;
        break;
      }
    }

    if (unstable) {
      const err = new Error('Canvas spoofing detected');
      return {
        testEmoji: function () { return null; },
        measureEmoji: function () { return { hash: 0, nonZero: 0, error: err }; },
        isBaselineHash: function () { return true; },
        baselineHashes: [],
        blocked: false,
        spoofing: true
      };
    }

    const baselines = new Set();
    const emojiPlaneTofuA = String.fromCodePoint(0x1FAFF);
    const emojiPlaneTofuB = String.fromCodePoint(0x1FAFE);
    const baselineCandidates = [
      '\uFFFF',
      '\uFFFD',
      '\uE000',
      emojiPlaneTofuA,
      emojiPlaneTofuA + '\uFE0F',
      emojiPlaneTofuB,
      emojiPlaneTofuB + '\uFE0F'
    ];

    for (const char of baselineCandidates) {
      const result = renderHash(char);
      if (!result.error && result.nonZero > 0) {
        baselines.add(result.hash);
      }
    }

    const blocked = baselines.size === 0;

    function isBaselineHash(hash) {
      return baselines.has(hash);
    }

    function measureEmoji(char) {
      if (blocked || unstable) return { hash: 0, nonZero: 0, error: new Error('Canvas unavailable') };
      return renderHash(char);
    }

    function testEmoji(char) {
      const result = measureEmoji(char);
      if (result.error || result.nonZero === 0) return null;
      return isBaselineHash(result.hash) ? false : true;
    }

    return {
      testEmoji: testEmoji,
      measureEmoji: measureEmoji,
      isBaselineHash: isBaselineHash,
      baselineHashes: Array.from(baselines),
      blocked: blocked,
      spoofing: unstable
    };
  }

  function compareVersions(a, b) {
    const partsA = String(a || '').split('.').map(Number);
    const partsB = String(b || '').split('.').map(Number);
    const length = Math.max(partsA.length, partsB.length);

    for (let i = 0; i < length; i++) {
      const valueA = partsA[i] || 0;
      const valueB = partsB[i] || 0;
      if (valueA > valueB) return 1;
      if (valueA < valueB) return -1;
    }

    return 0;
  }

  function formatPercent(value, digits) {
    if (typeof digits !== 'number') digits = 1;
    if (typeof value !== 'number' || Number.isNaN(value)) return '-';
    return `${(value * 100).toFixed(digits)}%`;
  }

  function displayNoAnalysis(message) {
    document.getElementById('results').classList.remove('hidden');
    document.getElementById('unicodeVersion').textContent = '-';
    document.getElementById('detectionMethod').textContent = '-';
    document.getElementById('unicodeConfidence').textContent = '-';

    const topMatchEl = document.getElementById('topMatch');
    topMatchEl.innerHTML = `
      <div class="top-match">
        <div class="match-header">No analysis</div>
        <div class="detail-item">
          <div class="detail-label">Reason</div>
          <div class="detail-value">${message}</div>
        </div>
      </div>
    `;

    document.getElementById('candidatesList').innerHTML = '';
    document.getElementById('sentinelProfile').innerHTML = '';
    document.getElementById('diagnostics').innerHTML = '';
  }

  function displayResults(analysis) {
    document.getElementById('results').classList.remove('hidden');

    const unicode = analysis.unicode_version || {};
    document.getElementById('unicodeVersion').textContent = unicode.version || '-';
    document.getElementById('detectionMethod').textContent = unicode.method ? unicode.method.replace(/_/g, ' ') : '-';
    document.getElementById('unicodeConfidence').textContent =
      typeof unicode.confidence === 'number' ? formatPercent(unicode.confidence, 0) : '-';

    const topMatch = analysis.top_match;
    const topMatchEl = document.getElementById('topMatch');
    if (!topMatch) {
      topMatchEl.innerHTML = `
        <div class="top-match">
          <div class="match-header">No match</div>
          <div class="detail-item">
            <div class="detail-label">Reason</div>
            <div class="detail-value">${analysis.error || 'No candidates available'}</div>
          </div>
        </div>
      `;
    } else {
      const accuracy = typeof topMatch.signals?.emoji_profile_accuracy === 'number'
        ? formatPercent(topMatch.signals.emoji_profile_accuracy, 1)
        : '-';

      topMatchEl.innerHTML = `
        <div class="top-match">
          <div class="match-header">${topMatch.vendor.replace(/_/g, ' ')} - ${topMatch.os_version}</div>
          <div class="match-details">
            <div class="detail-item">
              <div class="detail-label">Probability</div>
              <div class="detail-value">${formatPercent(topMatch.probability, 1)}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Score</div>
              <div class="detail-value">${topMatch.score}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Max Emoji Version</div>
              <div class="detail-value">${topMatch.max_emoji_version}</div>
            </div>
            <div class="detail-item">
              <div class="detail-label">Emoji Accuracy</div>
              <div class="detail-value">${accuracy}</div>
            </div>
          </div>
        </div>
      `;
    }

    const candidatesList = document.getElementById('candidatesList');
    const candidates = analysis.candidates || [];
    candidatesList.innerHTML = candidates.length === 0
      ? '<div class="candidate-item"><div class="candidate-info"><div class="candidate-name">No candidates</div></div></div>'
      : candidates.map(candidate => `
          <div class="candidate-item">
            <div class="candidate-info">
              <div class="candidate-name">${candidate.vendor.replace(/_/g, ' ')} ${candidate.os_version}</div>
              <div class="candidate-meta">Emoji ${candidate.max_emoji_version} • Score: ${candidate.score}</div>
            </div>
            <div class="candidate-score">
              <div class="probability">${formatPercent(candidate.probability, 1)}</div>
            </div>
          </div>
        `).join('');

    const profileEl = document.getElementById('sentinelProfile');
    const profile = analysis.emoji_profile && analysis.emoji_profile.versions ? analysis.emoji_profile.versions : {};
    const profileEntries = Object.entries(profile).sort((a, b) => compareVersions(b[0], a[0]));
    profileEl.innerHTML = profileEntries.length === 0
      ? '<div class="metric-card"><div class="metric-title">No profile</div><div class="metric-value">-</div></div>'
      : profileEntries.map(([version, stats]) => {
          const ratio = typeof stats.pass_ratio === 'number' ? formatPercent(stats.pass_ratio, 0) : '-';
          const counts = stats.total > 0 ? `${stats.passed}/${stats.total}` : '-';
          return `
            <div class="metric-card">
              <div class="metric-title">Unicode ${version}</div>
              <div class="metric-value">${counts} (${ratio})</div>
            </div>
          `;
        }).join('');

    const diagnosticsEl = document.getElementById('diagnostics');
    const diagnostics = analysis.diagnostics || {};
    const diagnosticItems = [];

    if (Array.isArray(analysis.warnings) && analysis.warnings.length > 0) {
      diagnosticItems.push({
        label: 'Warnings',
        value: analysis.warnings.join(' • ')
      });
    }
    if (typeof diagnostics.canvas_blocked === 'boolean') {
      diagnosticItems.push({
        label: 'Canvas Readback',
        value: diagnostics.canvas_blocked ? 'Blocked' : 'OK'
      });
    }
    if (typeof diagnostics.spoofing_detected === 'boolean' && diagnostics.spoofing_detected) {
      diagnosticItems.push({
        label: 'Anti-Fingerprinting',
        value: 'Spoofing detected'
      });
    }
    if (diagnostics.tofu_cluster && diagnostics.tofu_cluster.suspected) {
      const share = typeof diagnostics.tofu_cluster.share === 'number'
        ? formatPercent(diagnostics.tofu_cluster.share, 0)
        : '-';
      diagnosticItems.push({
        label: 'Tofu Cluster',
        value: `Dominant hash reused (${share})`
      });
    }
    if (diagnostics.user_agent) {
      diagnosticItems.push({ label: 'User Agent', value: diagnostics.user_agent });
    }
    if (diagnostics.user_agent_data) {
      diagnosticItems.push({
        label: 'UA-CH',
        value: JSON.stringify(diagnostics.user_agent_data)
      });
    }

    diagnosticsEl.innerHTML = diagnosticItems.length === 0
      ? '<div class="metric-card"><div class="metric-title">No diagnostics</div><div class="metric-value">-</div></div>'
      : diagnosticItems.map(item => `
          <div class="metric-card">
            <div class="metric-title">${item.label}</div>
            <div class="metric-value">${item.value}</div>
          </div>
        `).join('');
  }

  async function startTest() {
    const btn = document.getElementById('startTest');
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> Testing...';
    document.getElementById('results').classList.add('hidden');

    renderer = createEmojiRenderer();
    if (renderer.spoofing) {
      displayNoAnalysis('Canvas anti-fingerprinting or spoofing detected. Disable that protection to get reliable results.');
      document.getElementById('status').textContent = 'Error: Canvas spoofing detected';
      btn.textContent = 'Retry Test';
      btn.disabled = false;
      return;
    }
    if (renderer.blocked) {
      displayNoAnalysis('Canvas readback is blocked. This test requires canvas readback to run.');
      document.getElementById('status').textContent = 'Error: Canvas readback blocked';
      btn.textContent = 'Retry Test';
      btn.disabled = false;
      return;
    }

    document.getElementById('status').textContent = 'Loading server config...';

    try {
      await loadRuntimeConfig();
      document.getElementById('status').textContent = 'Loading sentinels...';

      const response = await fetch(`${API_BASE}/api/sentinels`, { cache: 'no-store' });
      if (response.status === 204) {
        throw new Error('Sentinels endpoint returned no data');
      }

      const sentinelsContentType = response.headers.get('content-type') || '';
      if (!response.ok) {
        let message = `Failed to load sentinels (HTTP ${response.status})`;
        if (sentinelsContentType.includes('application/json')) {
          try {
            const errorPayload = await response.json();
            if (errorPayload && errorPayload.error) message = String(errorPayload.error);
          } catch {
          }
        }
        throw new Error(message);
      }

      if (!sentinelsContentType.includes('application/json')) {
        throw new Error('Sentinels endpoint did not return JSON');
      }

      const sentinels = await response.json();
      const results = {};
      const measurements = {};
      const itemByChar = new Map();
      const allEmojis = [];

      for (const emojiList of Object.values(sentinels)) {
        for (const emoji of emojiList) {
          allEmojis.push(emoji);
        }
      }

      if (allEmojis.length === 0) {
        throw new Error('No sentinels loaded. Run the build pipeline first.');
      }

      document.getElementById('status').textContent = `Testing ${allEmojis.length} emojis...`;
      document.getElementById('emojiCount').textContent = `0 / ${allEmojis.length}`;

      const grid = document.getElementById('emojiGrid');
      grid.classList.remove('hidden');
      grid.innerHTML = '';

      for (let i = 0; i < allEmojis.length; i++) {
        const emoji = allEmojis[i];
        const measurement = renderer.measureEmoji(emoji.char);
        measurements[emoji.char] = measurement;

        let rendered = null;
        if (!measurement.error && measurement.nonZero > 0) {
          rendered = renderer.isBaselineHash(measurement.hash) ? false : true;
        }
        results[emoji.char] = rendered;

        const item = document.createElement('div');
        const stateClass = rendered === true ? 'pass' : rendered === false ? 'fail' : 'unknown';
        const stateLabel = rendered === true ? 'Supported' : rendered === false ? 'Not supported' : 'Unknown';
        item.className = `emoji-item ${stateClass}`;
        item.textContent = emoji.char;
        item.title = `${emoji.name} - ${stateLabel}`;
        grid.appendChild(item);
        itemByChar.set(emoji.char, item);

        document.getElementById('emojiCount').textContent = `${i + 1} / ${allEmojis.length}`;

        if (i % 10 === 0) {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }

      lastTofuCluster = null;
      const hashCounts = new Map();
      let considered = 0;

      for (const emoji of allEmojis) {
        const rendered = results[emoji.char];
        const measurement = measurements[emoji.char];
        if (rendered !== true) continue;
        if (!measurement || measurement.error || measurement.nonZero === 0) continue;
        considered += 1;
        hashCounts.set(measurement.hash, (hashCounts.get(measurement.hash) || 0) + 1);
      }

      let dominantHash = null;
      let dominantCount = 0;
      for (const [hash, count] of hashCounts.entries()) {
        if (count > dominantCount) {
          dominantCount = count;
          dominantHash = hash;
        }
      }

      const dominantShare = considered > 0 ? dominantCount / considered : 0;
      const tofuCfg = getTofuClusterConfig();
      const suspected = Boolean(
        tofuCfg.enabled &&
        dominantHash !== null &&
        considered >= tofuCfg.minConsideredTrue &&
        dominantCount >= tofuCfg.minDominantCount &&
        dominantShare >= tofuCfg.minShare &&
        !renderer.isBaselineHash(dominantHash)
      );
      const applied = Boolean(suspected && tofuCfg.applyCorrection);

      if (applied) {
        for (const emoji of allEmojis) {
          if (results[emoji.char] !== true) continue;
          const measurement = measurements[emoji.char];
          if (!measurement || measurement.error) continue;
          if (measurement.hash !== dominantHash) continue;

          results[emoji.char] = false;
          const item = itemByChar.get(emoji.char);
          if (item) {
            item.className = 'emoji-item fail';
            item.title = `${emoji.name} - Not supported`;
          }
        }
      }

      lastTofuCluster = tofuCfg.enabled ? {
        suspected: suspected,
        applied: applied,
        dominant_hash: dominantHash,
        dominant_count: dominantCount,
        considered_true_count: considered,
        share: Number(dominantShare.toFixed(3))
      } : null;

      sessionId = buildSessionId();
      document.getElementById('sessionId').textContent = sessionId;
      document.getElementById('status').textContent = 'Analyzing fingerprint...';

      const analysisResponse = await fetch(`${API_BASE}/api/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          session_id: sessionId,
          sentinel_results: results,
          diagnostics: collectDiagnostics(),
          timestamp: new Date().toISOString()
        })
      });

      const analysisContentType = analysisResponse.headers.get('content-type') || '';
      let analysisPayload = null;
      let responseText = '';

      if (analysisResponse.status !== 204) {
        if (analysisContentType.includes('application/json')) {
          try {
            analysisPayload = await analysisResponse.json();
          } catch {
          }
        } else {
          try {
            responseText = await analysisResponse.text();
          } catch {
          }
        }
      }

      if (!analysisResponse.ok) {
        const message = analysisPayload && analysisPayload.error
          ? analysisPayload.error
          : responseText || `Analysis failed (HTTP ${analysisResponse.status})`;
        throw new Error(message);
      }

      if (analysisResponse.status === 204) {
        displayNoAnalysis('Server returned no analysis (204 No Content).');
        document.getElementById('status').textContent = 'Complete (no analysis returned)';
        btn.textContent = 'Run Test Again';
        btn.disabled = false;
        return;
      }

      const analysis = analysisPayload && analysisPayload.analysis ? analysisPayload.analysis : null;
      if (analysis) {
        displayResults(analysis);
        const hasWarnings = Boolean(
          analysis.error ||
          (Array.isArray(analysis.warnings) && analysis.warnings.length > 0)
        );
        document.getElementById('status').textContent = hasWarnings ? 'Complete with warnings' : 'Complete';
      } else {
        displayNoAnalysis('Server did not return analysis (response_mode=ack/none or analysis disabled).');
        document.getElementById('status').textContent = 'Complete (analysis not returned by server)';
      }

      btn.textContent = 'Run Test Again';
      btn.disabled = false;
    } catch (error) {
      console.error('Test failed:', error);
      document.getElementById('status').textContent = `Error: ${error.message}`;
      btn.textContent = 'Retry Test';
      btn.disabled = false;
    }
  }

  document.addEventListener('DOMContentLoaded', function () {
    document.getElementById('startTest').addEventListener('click', function () {
      startTest();
    });
    loadRuntimeConfig();
  });
})();
