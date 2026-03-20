import { DEFAULT_CONFIG, buildUnicodeVersionPredicate, clampNumber } from './config.js';

export function inferOsFamilyFromUAChPlatform(platform) {
    const value = String(platform || '').toLowerCase();
    if (!value) return 'unknown';
    if (value.includes('mac')) return 'macos';
    if (value.includes('ios')) return 'ios';
    if (value.includes('iphone') || value.includes('ipad')) return 'ios';
    if (value.includes('android')) return 'android';
    if (value.includes('win')) return 'windows';
    if (value.includes('linux')) return 'linux';
    return 'unknown';
}

export function inferOsFamilyFromUserAgent(userAgent) {
    const ua = String(userAgent || '').toLowerCase();
    if (!ua) return 'unknown';

    if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
    if (ua.includes('android')) return 'android';
    if (ua.includes('windows nt')) return 'windows';
    if (ua.includes('macintosh') || ua.includes('mac os x')) return 'macos';
    if (ua.includes('linux')) return 'linux';
    return 'unknown';
}

export function inferOsFamilyHints(diagnostics) {
    const uaChPlatform = diagnostics?.user_agent_data?.platform;
    const familyFromUACh = inferOsFamilyFromUAChPlatform(uaChPlatform);
    if (familyFromUACh !== 'unknown') {
        return { family: familyFromUACh, source: 'ua_ch' };
    }

    const familyFromUA = inferOsFamilyFromUserAgent(diagnostics?.user_agent);
    return { family: familyFromUA, source: familyFromUA !== 'unknown' ? 'user_agent' : 'unknown' };
}

export function inferBrowserKey(diagnostics) {
    if (typeof diagnostics?.browser_label === 'string' && diagnostics.browser_label.trim()) {
        return diagnostics.browser_label.trim();
    }

    const userAgent = typeof diagnostics?.user_agent === 'string'
        ? diagnostics.user_agent.toLowerCase()
        : '';

    if (userAgent.includes('edg/')) return 'Edge';
    if (userAgent.includes('firefox/')) return 'Firefox';
    if (userAgent.includes('chrome/') && !userAgent.includes('edg/')) return 'Chrome';
    if (userAgent.includes('safari/') && !userAgent.includes('chrome/')) return 'Safari';
    return 'unknown_browser';
}

export class EmojiFingerprinter {
    constructor(database) {
        this.db = database;
    }

    vendorFamily(vendorKey) {
        if (vendorKey === 'apple_ios') return 'ios';
        if (vendorKey === 'apple_macos') return 'macos';
        if (vendorKey === 'microsoft_windows') return 'windows';
        if (vendorKey === 'google_android' || vendorKey === 'samsung') return 'android';
        if (vendorKey === 'google_noto') return 'linux';
        return 'unknown';
    }

    compareVersions(a, b) {
        const partsA = String(a || '').split('.').map(n => parseInt(n, 10));
        const partsB = String(b || '').split('.').map(n => parseInt(n, 10));
        const length = Math.max(partsA.length, partsB.length);

        for (let i = 0; i < length; i++) {
            const valueA = partsA[i] || 0;
            const valueB = partsB[i] || 0;
            if (valueA > valueB) return 1;
            if (valueA < valueB) return -1;
        }

        return 0;
    }

    getSortedVersions(desc = true, config) {
        const allowVersion = buildUnicodeVersionPredicate(config);
        const versions = Object.keys(this.db.unicode_versions || {}).filter(allowVersion);
        versions.sort((a, b) => this.compareVersions(a, b));
        return desc ? versions.reverse() : versions;
    }

    detectMaxUnicodeVersion(sentinelResults, config) {
        const detectionConfig = config?.analysis?.unicode_detection || DEFAULT_CONFIG.analysis.unicode_detection;
        const minCoverage = typeof detectionConfig.sentinel_full_match_min_coverage === 'number'
            ? detectionConfig.sentinel_full_match_min_coverage
            : DEFAULT_CONFIG.analysis.unicode_detection.sentinel_full_match_min_coverage;
        const fullConfidence = typeof detectionConfig.full_match_confidence === 'number'
            ? detectionConfig.full_match_confidence
            : DEFAULT_CONFIG.analysis.unicode_detection.full_match_confidence;
        const partialConfidence = typeof detectionConfig.partial_match_confidence === 'number'
            ? detectionConfig.partial_match_confidence
            : DEFAULT_CONFIG.analysis.unicode_detection.partial_match_confidence;
        const fallbackConfidence = typeof detectionConfig.fallback_confidence === 'number'
            ? detectionConfig.fallback_confidence
            : DEFAULT_CONFIG.analysis.unicode_detection.fallback_confidence;

        const versions = this.getSortedVersions(true, config);
        const results = sentinelResults || {};
        let hasKnownResults = false;

        for (const version of versions) {
            const sentinels = this.db.unicode_versions[version]?.sentinel_emojis || [];
            if (sentinels.length === 0) continue;

            const knownResults = sentinels
                .map(sentinel => results[sentinel.char])
                .filter(value => value === true || value === false);
            if (knownResults.length === 0) continue;
            hasKnownResults = true;

            const coverage = knownResults.length / sentinels.length;
            const allPassed = knownResults.every(value => value === true);
            if (allPassed && coverage >= minCoverage) {
                return {
                    version,
                    confidence: fullConfidence,
                    method: 'sentinel_full_match'
                };
            }
        }

        for (const version of versions) {
            const sentinels = this.db.unicode_versions[version]?.sentinel_emojis || [];
            const anyPassed = sentinels.some(sentinel => results[sentinel.char] === true);
            if (anyPassed) {
                return {
                    version,
                    confidence: partialConfidence,
                    method: 'sentinel_partial_match'
                };
            }
        }

        if (!hasKnownResults) {
            return {
                version: null,
                confidence: 0,
                method: 'no_data'
            };
        }

        return {
            version: versions[versions.length - 1] || null,
            confidence: fallbackConfidence,
            method: 'fallback_minimum'
        };
    }

    buildSentinelProfile(sentinelResults, config) {
        const results = sentinelResults || {};
        const versions = this.getSortedVersions(false, config);
        const profileConfig = config?.analysis?.unicode_detection?.profile || DEFAULT_CONFIG.analysis.unicode_detection.profile;
        const omitEmpty = profileConfig.omit_empty_versions !== false;

        const profile = {
            versions: {},
            totals: {
                passed: 0,
                failed: 0,
                unknown: 0,
                total: 0
            }
        };

        for (const version of versions) {
            const sentinels = this.db.unicode_versions[version]?.sentinel_emojis || [];
            if (sentinels.length === 0 && omitEmpty) continue;

            let passed = 0;
            let failed = 0;
            let unknown = 0;

            for (const sentinel of sentinels) {
                const value = results[sentinel.char];
                if (value === true) passed += 1;
                else if (value === false) failed += 1;
                else unknown += 1;
            }

            const total = passed + failed;
            profile.versions[version] = {
                passed,
                failed,
                unknown,
                total,
                pass_ratio: total > 0 ? passed / total : null
            };

            profile.totals.passed += passed;
            profile.totals.failed += failed;
            profile.totals.unknown += unknown;
        }

        profile.totals.total = profile.totals.passed + profile.totals.failed;
        return profile;
    }

    getCandidates(unicodeVersion) {
        const candidates = this.db.os_candidates_by_unicode[unicodeVersion] || [];
        return candidates.map(candidate => ({
            ...candidate,
            score: 0,
            signals: {}
        }));
    }

    scoreByEmojiProfile(candidates, profile) {
        const versions = Object.keys(profile.versions || {}).sort((a, b) => this.compareVersions(a, b));

        for (const candidate of candidates) {
            let match = 0;
            let mismatch = 0;
            let evaluated = 0;
            const candidateVersion = candidate.max_emoji_version || null;

            if (!candidateVersion) continue;

            for (const version of versions) {
                const stats = profile.versions[version];
                if (!stats || stats.total === 0) continue;
                const shouldPass = this.compareVersions(version, candidateVersion) <= 0;

                if (shouldPass) {
                    match += stats.passed;
                    mismatch += stats.failed;
                } else {
                    match += stats.failed;
                    mismatch += stats.passed;
                }

                evaluated += stats.total;
            }

            const total = match + mismatch;
            const accuracy = total > 0 ? match / total : 0;
            candidate.score = Math.round(accuracy * 100);
            candidate.signals = total > 0 ? {
                emoji_profile_accuracy: Number(accuracy.toFixed(3)),
                emoji_profile_mismatches: mismatch,
                emoji_profile_evaluated: evaluated
            } : {};
        }

        return candidates;
    }

    scoreByEnvironmentHints(candidates, diagnostics, config) {
        const hintsConfig = config?.analysis?.scoring?.environment_hints || DEFAULT_CONFIG.analysis.scoring.environment_hints;
        if (!hintsConfig || hintsConfig.enabled === false || hintsConfig.mode === 'disabled') {
            return candidates;
        }

        const uaHints = inferOsFamilyHints(diagnostics);
        const weights = hintsConfig.weights && typeof hintsConfig.weights === 'object' ? hintsConfig.weights : {};
        const uaMatchBonus = clampNumber(weights.ua_match_bonus, DEFAULT_CONFIG.analysis.scoring.environment_hints.weights.ua_match_bonus);
        const uaMismatchPenalty = clampNumber(weights.ua_mismatch_penalty, DEFAULT_CONFIG.analysis.scoring.environment_hints.weights.ua_mismatch_penalty);
        const appleCrossBonus = clampNumber(weights.apple_cross_bonus, DEFAULT_CONFIG.analysis.scoring.environment_hints.weights.apple_cross_bonus);

        const maxBaseScore = hintsConfig.mode === 'tie_break_only' && candidates.length > 0
            ? candidates.reduce((max, candidate) => Math.max(max, candidate.score), candidates[0].score)
            : null;

        for (const candidate of candidates) {
            if (maxBaseScore !== null && candidate.score !== maxBaseScore) continue;

            const family = this.vendorFamily(candidate.vendor);
            const signals = candidate.signals && typeof candidate.signals === 'object' ? { ...candidate.signals } : {};
            let delta = 0;

            if (uaHints.family !== 'unknown') {
                const match = family === uaHints.family;
                const appleCross = (uaHints.family === 'macos' && family === 'ios') || (uaHints.family === 'ios' && family === 'macos');

                if (match) delta += uaMatchBonus;
                else if (appleCross) delta += appleCrossBonus;
                else delta -= uaMismatchPenalty;

                signals.ua_family = uaHints.family;
                signals.ua_source = uaHints.source;
                signals.ua_family_match = match;
            }

            candidate.score = Math.round(candidate.score + delta);
            candidate.signals = signals;
        }

        return candidates;
    }

    analyze(testResults, config) {
        const cfg = config && typeof config === 'object' ? config : DEFAULT_CONFIG;
        const analysisConfig = cfg.analysis && typeof cfg.analysis === 'object' ? cfg.analysis : DEFAULT_CONFIG.analysis;
        const responseConfig = analysisConfig.response && typeof analysisConfig.response === 'object'
            ? analysisConfig.response
            : DEFAULT_CONFIG.analysis.response;

        const sentinelResults = testResults ? testResults.sentinel_results : null;
        const diagnostics = testResults && testResults.diagnostics && typeof testResults.diagnostics === 'object'
            ? testResults.diagnostics
            : null;
        const timestamp = (testResults && typeof testResults.timestamp === 'string' && testResults.timestamp.trim())
            ? testResults.timestamp
            : new Date().toISOString();

        const warnings = [];

        const hardFail = (message) => ({
            unicode_version: null,
            emoji_profile: null,
            candidates: [],
            top_match: null,
            confidence: 0,
            diagnostics: diagnostics || null,
            error: message,
            timestamp
        });

        if (analysisConfig.guards?.spoofing_detected?.enabled && diagnostics?.spoofing_detected) {
            const message = 'Canvas Spoofing Detected (Random Noise): Results Unreliable';
            const policy = analysisConfig.guards.spoofing_detected.policy || 'reject';
            if (policy === 'reject') return hardFail(message);
            if (policy === 'warn') warnings.push(message);
        }

        if (analysisConfig.guards?.canvas_blocked?.enabled && diagnostics?.canvas_blocked) {
            const message = 'Canvas Readback Blocked: Results Unreliable';
            const policy = analysisConfig.guards.canvas_blocked.policy || 'reject';
            if (policy === 'reject') return hardFail(message);
            if (policy === 'warn') warnings.push(message);
        }

        const tofuGuard = analysisConfig.guards?.tofu_cluster || DEFAULT_CONFIG.analysis.guards.tofu_cluster;
        if (tofuGuard.enabled && diagnostics) {
            const tofuCluster = diagnostics.tofu_cluster && typeof diagnostics.tofu_cluster === 'object'
                ? diagnostics.tofu_cluster
                : null;

            const shareOk = typeof tofuCluster?.share === 'number' ? tofuCluster.share >= tofuGuard.min_share : true;
            const consideredOk = typeof tofuCluster?.considered_true_count === 'number'
                ? tofuCluster.considered_true_count >= tofuGuard.min_considered_true
                : true;
            const dominantOk = typeof tofuCluster?.dominant_count === 'number'
                ? tofuCluster.dominant_count >= tofuGuard.min_dominant_count
                : true;

            const tofuSuspicious = Boolean(
                tofuCluster &&
                tofuCluster.suspected === true &&
                shareOk &&
                consideredOk &&
                dominantOk
            );

            if (tofuSuspicious && tofuGuard.require_applied && tofuCluster.applied !== true) {
                const message = 'Tofu Hash Cluster Detected: Missing-glyph false positives likely';
                const policy = tofuGuard.policy || 'reject';
                if (policy === 'reject') return hardFail(message);
                if (policy === 'warn') warnings.push(message);
            }
        }

        const unicodeDetection = this.detectMaxUnicodeVersion(sentinelResults, cfg);
        const emojiProfile = this.buildSentinelProfile(sentinelResults, cfg);

        if (!unicodeDetection.version) {
            return {
                unicode_version: responseConfig.include_unicode_detection ? unicodeDetection : null,
                emoji_profile: responseConfig.include_emoji_profile ? emojiProfile : null,
                candidates: [],
                top_match: null,
                confidence: 0,
                diagnostics: responseConfig.include_diagnostics ? (diagnostics || null) : null,
                warnings: warnings.length > 0 ? warnings : undefined,
                error: warnings[0] || 'No usable sentinel results',
                timestamp
            };
        }

        let candidates = this.getCandidates(unicodeDetection.version);
        const uaHints = inferOsFamilyHints(diagnostics);

        if (candidates.length === 0) {
            return {
                unicode_version: responseConfig.include_unicode_detection ? unicodeDetection : null,
                emoji_profile: responseConfig.include_emoji_profile ? emojiProfile : null,
                candidates: [],
                top_match: null,
                confidence: 0,
                diagnostics: responseConfig.include_diagnostics ? (diagnostics || null) : null,
                warnings: warnings.length > 0 ? warnings : undefined,
                error: warnings[0] || 'No OS candidates found for detected Unicode version',
                timestamp
            };
        }

        if (analysisConfig.scoring?.emoji_profile?.enabled !== false) {
            candidates = this.scoreByEmojiProfile(candidates, emojiProfile);
        }

        if (analysisConfig.scoring?.environment_hints?.enabled && analysisConfig.scoring.environment_hints.mode !== 'disabled') {
            candidates = this.scoreByEnvironmentHints(candidates, diagnostics, cfg);
        }

        const clampMin = typeof analysisConfig.score?.clamp?.min === 'number'
            ? analysisConfig.score.clamp.min
            : DEFAULT_CONFIG.analysis.score.clamp.min;
        const clampMax = typeof analysisConfig.score?.clamp?.max === 'number'
            ? analysisConfig.score.clamp.max
            : DEFAULT_CONFIG.analysis.score.clamp.max;

        for (const candidate of candidates) {
            candidate.score = clampNumber(candidate.score, 0, { min: clampMin, max: clampMax });
        }

        const narrowingConfig = analysisConfig.scoring?.ua_ch_narrowing || DEFAULT_CONFIG.analysis.scoring.ua_ch_narrowing;
        if (narrowingConfig.enabled && uaHints.source === 'ua_ch' && uaHints.family !== 'unknown') {
            const allow = new Set([uaHints.family]);
            if (narrowingConfig.allow_apple_cross) {
                if (uaHints.family === 'macos') allow.add('ios');
                if (uaHints.family === 'ios') allow.add('macos');
            }

            const narrowed = candidates.filter(candidate => allow.has(this.vendorFamily(candidate.vendor)));
            if (narrowed.length > 0) candidates = narrowed;
        }

        candidates.sort((a, b) => b.score - a.score);

        const totalScore = candidates.reduce((sum, candidate) => sum + Math.max(candidate.score, 0), 0);
        const uniform = candidates.length > 0 ? 1 / candidates.length : 0;
        candidates = candidates.map(candidate => ({
            ...candidate,
            probability: totalScore > 0 ? candidate.score / totalScore : uniform
        }));

        const topMatch = candidates[0];
        const maxCandidates = responseConfig.include_candidates
            ? clampNumber(responseConfig.max_candidates, DEFAULT_CONFIG.analysis.response.max_candidates, { min: 0, max: 10_000 })
            : 0;

        let responseCandidates = responseConfig.include_candidates
            ? candidates.slice(0, maxCandidates)
            : [];

        if (!responseConfig.include_signals) {
            responseCandidates = responseCandidates.map(({ signals: _signals, ...rest }) => rest);
        }

        const responseTopMatch = topMatch ? {
            vendor: topMatch.vendor,
            os_version: topMatch.os_version,
            max_emoji_version: topMatch.max_emoji_version,
            probability: topMatch.probability,
            score: topMatch.score,
            ...(responseConfig.include_signals ? { signals: topMatch.signals } : {})
        } : null;

        const analysis = {
            unicode_version: responseConfig.include_unicode_detection ? unicodeDetection : null,
            emoji_profile: responseConfig.include_emoji_profile ? emojiProfile : null,
            candidates: responseCandidates,
            top_match: responseTopMatch,
            confidence: topMatch ? topMatch.probability : 0,
            diagnostics: responseConfig.include_diagnostics ? (diagnostics || null) : null,
            timestamp
        };

        if (warnings.length > 0) {
            analysis.warnings = warnings;
            analysis.error = warnings[0];
        }

        return analysis;
    }
}
