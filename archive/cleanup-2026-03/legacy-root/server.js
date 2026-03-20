// server.js - Emoji fingerprinting server
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DEFAULT_CONFIG = {
    schema_version: 1,
    service: {
        enabled: true,
        disabled_response: {
            mode: 'empty',
            status: 204,
            json: { success: false, error: 'disabled' },
            text: 'disabled'
        }
    },
    data: {
        emoji_db_path: './data/emoji-fingerprint-db.json'
    },
    server: {
        host: '127.0.0.1',
        port: 3003,
        trust_proxy: false,
        request_timeout_ms: 30_000
    },
    cors: {
        enabled: true,
        allow_origin: '*',
        allow_methods: ['GET', 'POST', 'OPTIONS'],
        allow_headers: ['Content-Type', 'Authorization'],
        max_age_seconds: 600
    },
    security_headers: {
        enabled: true,
        cache_control: 'no-store',
        referrer_policy: 'no-referrer',
        x_content_type_options: true,
        x_frame_options: 'DENY',
        cross_origin_opener_policy: 'same-origin',
        cross_origin_resource_policy: 'same-origin'
    },
    logging: {
        level: 'info',
        requests: {
            enabled: true,
            include_ip: true,
            include_user_agent: false
        }
    },
    rate_limit: {
        enabled: false,
        window_ms: 60_000,
        max_requests: 120,
        key: 'ip',
        header_name: 'x-rate-limit-key'
    },
    limits: {
        max_body_bytes: 1_000_000,
        max_sentinel_results: 2000,
        max_session_store_entries: 5000
    },
    auth: {
        admin: {
            enabled: false,
            env: 'EMOJI_FP_ADMIN_TOKEN',
            value: null
        },
        request: {
            header: 'Authorization',
            allow_bearer_prefix: true,
            query_param: 'token'
        }
    },
    endpoints: {
        ui: { enabled: true },
        health: { enabled: true },
        config: { enabled: true },
        test: { enabled: true, response_mode: 'full' },
        fingerprint: { enabled: true },
        database: { enabled: true, require_admin: false },
        sentinels: { enabled: true }
    },
    storage: {
        session_store: {
            enabled: true,
            ttl_ms: 86_400_000
        },
        persistence: {
            enabled: true,
            path: './data/fingerprints.json',
            save_debounce_ms: 200,
            store_raw_test_results: true,
            store_analysis: true,
            store_diagnostics: true,
            max_sessions_per_device_browser: 1000
        }
    },
    analysis: {
        enabled: true,
        response: {
            include_candidates: true,
            max_candidates: 10,
            include_emoji_profile: true,
            include_unicode_detection: true,
            include_diagnostics: true,
            include_signals: true
        },
        unicode_detection: {
            sentinel_full_match_min_coverage: 0.5,
            full_match_confidence: 1,
            partial_match_confidence: 0.6,
            fallback_confidence: 0.3,
            version_filter: {
                mode: 'exclude',
                versions: ['12.1', '13.1', '15.1']
            },
            sentinels: {
                omit_empty_versions: true
            },
            profile: {
                omit_empty_versions: true
            }
        },
        score: {
            clamp: {
                min: 0,
                max: 125
            }
        },
        scoring: {
            emoji_profile: { enabled: true },
            environment_hints: {
                enabled: true,
                mode: 'score',
                weights: {
                    ua_match_bonus: 25,
                    ua_mismatch_penalty: 10,
                    apple_cross_bonus: 10
                }
            },
            ua_ch_narrowing: {
                enabled: true,
                allow_apple_cross: true
            }
        },
        guards: {
            spoofing_detected: { enabled: true, policy: 'reject' },
            canvas_blocked: { enabled: true, policy: 'reject' },
            tofu_cluster: {
                enabled: true,
                policy: 'reject',
                require_applied: true,
                min_considered_true: 12,
                min_dominant_count: 8,
                min_share: 0.25
            }
        }
    },
    client: {
        ui: {
            show_diagnostics: true,
            show_candidates: true,
            show_sentinel_profile: true
        },
        tofu_cluster: {
            enabled: true,
            apply_correction: true
        }
    }
};

const CONFIG_PATH = process.env.EMOJI_FP_CONFIG_PATH
    ? path.resolve(process.env.EMOJI_FP_CONFIG_PATH)
    : path.join(__dirname, 'config.json');

function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
    if (!isPlainObject(base)) return override;
    if (!isPlainObject(override)) return base;

    const out = { ...base };
    for (const [key, value] of Object.entries(override)) {
        if (value === undefined) continue;
        if (isPlainObject(value) && isPlainObject(out[key])) {
            out[key] = deepMerge(out[key], value);
        } else {
            out[key] = value;
        }
    }
    return out;
}

function clampNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue)) return fallback;
    return Math.max(min, Math.min(max, numberValue));
}

function normalizeConfig(rawConfig) {
    const merged = deepMerge(DEFAULT_CONFIG, isPlainObject(rawConfig) ? rawConfig : {});

    merged.schema_version = clampNumber(merged.schema_version, DEFAULT_CONFIG.schema_version, { min: 1, max: 1_000_000 });

    merged.service.enabled = Boolean(merged.service.enabled);
    merged.service.disabled_response = merged.service.disabled_response && typeof merged.service.disabled_response === 'object'
        ? merged.service.disabled_response
        : DEFAULT_CONFIG.service.disabled_response;
    merged.service.disabled_response.mode = ['json', 'text', 'empty'].includes(merged.service.disabled_response.mode)
        ? merged.service.disabled_response.mode
        : DEFAULT_CONFIG.service.disabled_response.mode;
    merged.service.disabled_response.status = clampNumber(
        merged.service.disabled_response.status,
        DEFAULT_CONFIG.service.disabled_response.status,
        { min: 100, max: 599 }
    );

    merged.server.host = typeof merged.server.host === 'string' && merged.server.host.trim()
        ? merged.server.host.trim()
        : DEFAULT_CONFIG.server.host;
    merged.server.port = clampNumber(merged.server.port, DEFAULT_CONFIG.server.port, { min: 1, max: 65535 });
    merged.server.trust_proxy = Boolean(merged.server.trust_proxy);
    merged.server.request_timeout_ms = clampNumber(merged.server.request_timeout_ms, DEFAULT_CONFIG.server.request_timeout_ms, { min: 0, max: 300_000 });

    merged.cors.enabled = Boolean(merged.cors.enabled);
    merged.cors.allow_origin = typeof merged.cors.allow_origin === 'string' ? merged.cors.allow_origin : DEFAULT_CONFIG.cors.allow_origin;
    merged.cors.allow_methods = Array.isArray(merged.cors.allow_methods) ? merged.cors.allow_methods : DEFAULT_CONFIG.cors.allow_methods;
    merged.cors.allow_headers = Array.isArray(merged.cors.allow_headers) ? merged.cors.allow_headers : DEFAULT_CONFIG.cors.allow_headers;
    merged.cors.max_age_seconds = clampNumber(merged.cors.max_age_seconds, DEFAULT_CONFIG.cors.max_age_seconds, { min: 0, max: 86_400 });

    merged.security_headers.enabled = Boolean(merged.security_headers.enabled);

    merged.logging.level = typeof merged.logging.level === 'string' ? merged.logging.level : DEFAULT_CONFIG.logging.level;
    merged.logging.requests.enabled = Boolean(merged.logging.requests.enabled);
    merged.logging.requests.include_ip = Boolean(merged.logging.requests.include_ip);
    merged.logging.requests.include_user_agent = Boolean(merged.logging.requests.include_user_agent);

    merged.rate_limit.enabled = Boolean(merged.rate_limit.enabled);
    merged.rate_limit.window_ms = clampNumber(merged.rate_limit.window_ms, DEFAULT_CONFIG.rate_limit.window_ms, { min: 100, max: 3_600_000 });
    merged.rate_limit.max_requests = clampNumber(merged.rate_limit.max_requests, DEFAULT_CONFIG.rate_limit.max_requests, { min: 1, max: 1_000_000 });
    merged.rate_limit.key = merged.rate_limit.key === 'ip' || merged.rate_limit.key === 'header' ? merged.rate_limit.key : DEFAULT_CONFIG.rate_limit.key;

    merged.limits.max_body_bytes = clampNumber(merged.limits.max_body_bytes, DEFAULT_CONFIG.limits.max_body_bytes, { min: 1_000, max: 50_000_000 });
    merged.limits.max_sentinel_results = clampNumber(merged.limits.max_sentinel_results, DEFAULT_CONFIG.limits.max_sentinel_results, { min: 1, max: 100_000 });
    merged.limits.max_session_store_entries = clampNumber(merged.limits.max_session_store_entries, DEFAULT_CONFIG.limits.max_session_store_entries, { min: 0, max: 5_000_000 });

    merged.auth.admin.enabled = Boolean(merged.auth.admin.enabled);
    merged.auth.admin.env = typeof merged.auth.admin.env === 'string' && merged.auth.admin.env.trim()
        ? merged.auth.admin.env.trim()
        : DEFAULT_CONFIG.auth.admin.env;
    merged.auth.admin.value = typeof merged.auth.admin.value === 'string' && merged.auth.admin.value.trim()
        ? merged.auth.admin.value.trim()
        : null;

    merged.auth.request.header = typeof merged.auth.request.header === 'string' && merged.auth.request.header.trim()
        ? merged.auth.request.header.trim()
        : DEFAULT_CONFIG.auth.request.header;
    merged.auth.request.allow_bearer_prefix = Boolean(merged.auth.request.allow_bearer_prefix);
    merged.auth.request.query_param = typeof merged.auth.request.query_param === 'string' && merged.auth.request.query_param.trim()
        ? merged.auth.request.query_param.trim()
        : DEFAULT_CONFIG.auth.request.query_param;

    merged.endpoints = merged.endpoints && typeof merged.endpoints === 'object' ? merged.endpoints : DEFAULT_CONFIG.endpoints;
    for (const [key, defaultValue] of Object.entries(DEFAULT_CONFIG.endpoints)) {
        const endpoint = merged.endpoints[key] && typeof merged.endpoints[key] === 'object' ? merged.endpoints[key] : {};
        endpoint.enabled = typeof endpoint.enabled === 'boolean' ? endpoint.enabled : defaultValue.enabled;
        merged.endpoints[key] = endpoint;
    }
    merged.endpoints.test.response_mode = ['full', 'minimal', 'ack', 'none'].includes(merged.endpoints.test.response_mode)
        ? merged.endpoints.test.response_mode
        : DEFAULT_CONFIG.endpoints.test.response_mode;
    merged.endpoints.database.require_admin = Boolean(merged.endpoints.database.require_admin);

    merged.storage.session_store.enabled = Boolean(merged.storage.session_store.enabled);
    merged.storage.session_store.ttl_ms = clampNumber(merged.storage.session_store.ttl_ms, DEFAULT_CONFIG.storage.session_store.ttl_ms, { min: 0, max: 31_536_000_000 });
    merged.storage.persistence.enabled = Boolean(merged.storage.persistence.enabled);
    merged.storage.persistence.path = typeof merged.storage.persistence.path === 'string' && merged.storage.persistence.path.trim()
        ? merged.storage.persistence.path.trim()
        : DEFAULT_CONFIG.storage.persistence.path;
    merged.storage.persistence.save_debounce_ms = clampNumber(merged.storage.persistence.save_debounce_ms, DEFAULT_CONFIG.storage.persistence.save_debounce_ms, { min: 0, max: 60_000 });
    merged.storage.persistence.store_raw_test_results = Boolean(merged.storage.persistence.store_raw_test_results);
    merged.storage.persistence.store_analysis = Boolean(merged.storage.persistence.store_analysis);
    merged.storage.persistence.store_diagnostics = Boolean(merged.storage.persistence.store_diagnostics);
    merged.storage.persistence.max_sessions_per_device_browser = clampNumber(
        merged.storage.persistence.max_sessions_per_device_browser,
        DEFAULT_CONFIG.storage.persistence.max_sessions_per_device_browser,
        { min: 0, max: 1_000_000 }
    );

    merged.analysis.enabled = Boolean(merged.analysis.enabled);
    merged.analysis.response.include_candidates = Boolean(merged.analysis.response.include_candidates);
    merged.analysis.response.max_candidates = clampNumber(merged.analysis.response.max_candidates, DEFAULT_CONFIG.analysis.response.max_candidates, { min: 0, max: 10_000 });
    merged.analysis.response.include_emoji_profile = Boolean(merged.analysis.response.include_emoji_profile);
    merged.analysis.response.include_unicode_detection = Boolean(merged.analysis.response.include_unicode_detection);
    merged.analysis.response.include_diagnostics = Boolean(merged.analysis.response.include_diagnostics);
    merged.analysis.response.include_signals = Boolean(merged.analysis.response.include_signals);

    merged.analysis.unicode_detection.sentinel_full_match_min_coverage = clampNumber(
        merged.analysis.unicode_detection.sentinel_full_match_min_coverage,
        DEFAULT_CONFIG.analysis.unicode_detection.sentinel_full_match_min_coverage,
        { min: 0, max: 1 }
    );
    merged.analysis.unicode_detection.full_match_confidence = clampNumber(
        merged.analysis.unicode_detection.full_match_confidence,
        DEFAULT_CONFIG.analysis.unicode_detection.full_match_confidence,
        { min: 0, max: 1 }
    );
    merged.analysis.unicode_detection.partial_match_confidence = clampNumber(
        merged.analysis.unicode_detection.partial_match_confidence,
        DEFAULT_CONFIG.analysis.unicode_detection.partial_match_confidence,
        { min: 0, max: 1 }
    );
    merged.analysis.unicode_detection.fallback_confidence = clampNumber(
        merged.analysis.unicode_detection.fallback_confidence,
        DEFAULT_CONFIG.analysis.unicode_detection.fallback_confidence,
        { min: 0, max: 1 }
    );

    const versionFilter = merged.analysis.unicode_detection.version_filter && typeof merged.analysis.unicode_detection.version_filter === 'object'
        ? merged.analysis.unicode_detection.version_filter
        : DEFAULT_CONFIG.analysis.unicode_detection.version_filter;
    versionFilter.mode = ['none', 'include', 'exclude'].includes(versionFilter.mode)
        ? versionFilter.mode
        : DEFAULT_CONFIG.analysis.unicode_detection.version_filter.mode;
    versionFilter.versions = Array.isArray(versionFilter.versions)
        ? versionFilter.versions.map(String)
        : DEFAULT_CONFIG.analysis.unicode_detection.version_filter.versions;
    merged.analysis.unicode_detection.version_filter = versionFilter;

    merged.analysis.unicode_detection.sentinels = merged.analysis.unicode_detection.sentinels && typeof merged.analysis.unicode_detection.sentinels === 'object'
        ? merged.analysis.unicode_detection.sentinels
        : DEFAULT_CONFIG.analysis.unicode_detection.sentinels;
    merged.analysis.unicode_detection.sentinels.omit_empty_versions = Boolean(merged.analysis.unicode_detection.sentinels.omit_empty_versions);

    merged.analysis.unicode_detection.profile = merged.analysis.unicode_detection.profile && typeof merged.analysis.unicode_detection.profile === 'object'
        ? merged.analysis.unicode_detection.profile
        : DEFAULT_CONFIG.analysis.unicode_detection.profile;
    merged.analysis.unicode_detection.profile.omit_empty_versions = Boolean(merged.analysis.unicode_detection.profile.omit_empty_versions);

    merged.analysis.score.clamp.min = clampNumber(merged.analysis.score.clamp.min, DEFAULT_CONFIG.analysis.score.clamp.min);
    merged.analysis.score.clamp.max = clampNumber(merged.analysis.score.clamp.max, DEFAULT_CONFIG.analysis.score.clamp.max);

    merged.analysis.scoring.emoji_profile.enabled = Boolean(merged.analysis.scoring.emoji_profile.enabled);
    merged.analysis.scoring.environment_hints.enabled = Boolean(merged.analysis.scoring.environment_hints.enabled);
    merged.analysis.scoring.environment_hints.mode = ['score', 'tie_break_only', 'disabled'].includes(merged.analysis.scoring.environment_hints.mode)
        ? merged.analysis.scoring.environment_hints.mode
        : DEFAULT_CONFIG.analysis.scoring.environment_hints.mode;
    merged.analysis.scoring.environment_hints.weights.ua_match_bonus = clampNumber(
        merged.analysis.scoring.environment_hints.weights.ua_match_bonus,
        DEFAULT_CONFIG.analysis.scoring.environment_hints.weights.ua_match_bonus,
        { min: -1000, max: 1000 }
    );
    merged.analysis.scoring.environment_hints.weights.ua_mismatch_penalty = clampNumber(
        merged.analysis.scoring.environment_hints.weights.ua_mismatch_penalty,
        DEFAULT_CONFIG.analysis.scoring.environment_hints.weights.ua_mismatch_penalty,
        { min: 0, max: 1000 }
    );
    merged.analysis.scoring.environment_hints.weights.apple_cross_bonus = clampNumber(
        merged.analysis.scoring.environment_hints.weights.apple_cross_bonus,
        DEFAULT_CONFIG.analysis.scoring.environment_hints.weights.apple_cross_bonus,
        { min: -1000, max: 1000 }
    );
    merged.analysis.scoring.ua_ch_narrowing.enabled = Boolean(merged.analysis.scoring.ua_ch_narrowing.enabled);
    merged.analysis.scoring.ua_ch_narrowing.allow_apple_cross = Boolean(merged.analysis.scoring.ua_ch_narrowing.allow_apple_cross);

    merged.analysis.guards.spoofing_detected.enabled = Boolean(merged.analysis.guards.spoofing_detected.enabled);
    merged.analysis.guards.spoofing_detected.policy = ['reject', 'warn', 'ignore'].includes(merged.analysis.guards.spoofing_detected.policy)
        ? merged.analysis.guards.spoofing_detected.policy
        : DEFAULT_CONFIG.analysis.guards.spoofing_detected.policy;
    merged.analysis.guards.canvas_blocked.enabled = Boolean(merged.analysis.guards.canvas_blocked.enabled);
    merged.analysis.guards.canvas_blocked.policy = ['reject', 'warn', 'ignore'].includes(merged.analysis.guards.canvas_blocked.policy)
        ? merged.analysis.guards.canvas_blocked.policy
        : DEFAULT_CONFIG.analysis.guards.canvas_blocked.policy;

    merged.analysis.guards.tofu_cluster.enabled = Boolean(merged.analysis.guards.tofu_cluster.enabled);
    merged.analysis.guards.tofu_cluster.policy = ['reject', 'warn', 'ignore'].includes(merged.analysis.guards.tofu_cluster.policy)
        ? merged.analysis.guards.tofu_cluster.policy
        : DEFAULT_CONFIG.analysis.guards.tofu_cluster.policy;
    merged.analysis.guards.tofu_cluster.require_applied = Boolean(merged.analysis.guards.tofu_cluster.require_applied);
    merged.analysis.guards.tofu_cluster.min_considered_true = clampNumber(
        merged.analysis.guards.tofu_cluster.min_considered_true,
        DEFAULT_CONFIG.analysis.guards.tofu_cluster.min_considered_true,
        { min: 0, max: 1_000_000 }
    );
    merged.analysis.guards.tofu_cluster.min_dominant_count = clampNumber(
        merged.analysis.guards.tofu_cluster.min_dominant_count,
        DEFAULT_CONFIG.analysis.guards.tofu_cluster.min_dominant_count,
        { min: 0, max: 1_000_000 }
    );
    merged.analysis.guards.tofu_cluster.min_share = clampNumber(
        merged.analysis.guards.tofu_cluster.min_share,
        DEFAULT_CONFIG.analysis.guards.tofu_cluster.min_share,
        { min: 0, max: 1 }
    );

    merged.client.ui.show_diagnostics = Boolean(merged.client.ui.show_diagnostics);
    merged.client.ui.show_candidates = Boolean(merged.client.ui.show_candidates);
    merged.client.ui.show_sentinel_profile = Boolean(merged.client.ui.show_sentinel_profile);
    merged.client.tofu_cluster.enabled = Boolean(merged.client.tofu_cluster.enabled);
    merged.client.tofu_cluster.apply_correction = Boolean(merged.client.tofu_cluster.apply_correction);

    return merged;
}

function buildUnicodeVersionPredicate(config) {
    const filter = config && config.analysis && config.analysis.unicode_detection && config.analysis.unicode_detection.version_filter
        ? config.analysis.unicode_detection.version_filter
        : DEFAULT_CONFIG.analysis.unicode_detection.version_filter;

    if (!filter || filter.mode === 'none') return () => true;

    const versions = Array.isArray(filter.versions) ? new Set(filter.versions.map(v => String(v))) : new Set();
    if (filter.mode === 'include') return (version) => versions.has(String(version));
    if (filter.mode === 'exclude') return (version) => !versions.has(String(version));
    return () => true;
}

const configCache = {
    mtimeMs: null,
    config: DEFAULT_CONFIG,
    lastError: null
};

function getRuntimeConfig() {
    try {
        const stat = fs.statSync(CONFIG_PATH);
        if (configCache.mtimeMs !== stat.mtimeMs) {
            const raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
            configCache.config = normalizeConfig(raw);
            configCache.mtimeMs = stat.mtimeMs;
            configCache.lastError = null;
        }
    } catch (error) {
        configCache.lastError = error;
        if (!configCache.mtimeMs) {
            configCache.config = DEFAULT_CONFIG;
        }
    }

    return configCache.config;
}

function resolveRepoPath(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const trimmed = value.trim();
    return path.isAbsolute(trimmed) ? trimmed : path.join(__dirname, trimmed);
}

const STARTUP_CONFIG = getRuntimeConfig();
const HOST = process.env.HOST || STARTUP_CONFIG.server.host;
const PORT = clampNumber(process.env.PORT, STARTUP_CONFIG.server.port, { min: 1, max: 65535 });

// In-memory storage
const sessionStore = new Map();
// Persistent storage
const DB_PATH = resolveRepoPath(STARTUP_CONFIG.storage.persistence.path) || path.join(__dirname, 'data', 'fingerprints.json');
const EMOJI_DB_PATH = resolveRepoPath(STARTUP_CONFIG.data?.emoji_db_path) || path.join(__dirname, 'data', 'emoji-fingerprint-db.json');

// Load master emoji database
let EMOJI_DB = null;
try {
    EMOJI_DB = JSON.parse(fs.readFileSync(EMOJI_DB_PATH, 'utf8'));
    console.log('✓ Loaded emoji database');
} catch (error) {
    console.error('⚠ Warning: Could not load emoji database. Run build-master-database.js first.');
    EMOJI_DB = { unicode_versions: {}, vendors: {}, os_candidates_by_unicode: {} };
}

// Load or initialize persistent fingerprint database
let persistentDB = { schema_version: 1, sessions: {}, devices: {} };
if (STARTUP_CONFIG.storage.persistence.enabled && fs.existsSync(DB_PATH)) {
    try {
        persistentDB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        const sessionCount = persistentDB.sessions && typeof persistentDB.sessions === 'object'
            ? Object.keys(persistentDB.sessions).length
            : 0;
        console.log(`✓ Loaded ${sessionCount} fingerprints from disk`);
    } catch (error) {
        console.error('⚠ Could not load fingerprints.json, starting fresh');
    }
}

function normalizePersistentDB(db) {
    const normalized = db && typeof db === 'object' ? db : {};
    if (!normalized.schema_version) normalized.schema_version = 1;
    if (!normalized.sessions || typeof normalized.sessions !== 'object') normalized.sessions = {};
    if (!normalized.devices || typeof normalized.devices !== 'object') normalized.devices = {};

    for (const [deviceKey, deviceValue] of Object.entries(normalized.devices)) {
        if (deviceValue && deviceValue.browsers) continue;

        const browsers = {};
        if (deviceValue && typeof deviceValue === 'object') {
            for (const [browserKey, sessions] of Object.entries(deviceValue)) {
                if (browserKey === 'browsers') continue;
                browsers[browserKey] = {
                    browser_key: browserKey,
                    sessions: Array.isArray(sessions) ? sessions : []
                };
            }
        }

        normalized.devices[deviceKey] = {
            device_key: deviceKey,
            browsers
        };
    }

    return normalized;
}

persistentDB = normalizePersistentDB(persistentDB);

// Fingerprint scoring engine
class EmojiFingerprinter {
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

    /**
     * Detect maximum supported Unicode version from test results
     */
    detectMaxUnicodeVersion(sentinelResults, config) {
        const detectionConfig = config && config.analysis && config.analysis.unicode_detection
            ? config.analysis.unicode_detection
            : DEFAULT_CONFIG.analysis.unicode_detection;
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

            // Check if ALL known sentinels for this version passed
            // AND we have sufficient coverage (at least 50% of sentinels yielded a result)
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

        // Fallback: find highest version with ANY passing sentinel
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
        const profileConfig = config && config.analysis && config.analysis.unicode_detection && config.analysis.unicode_detection.profile
            ? config.analysis.unicode_detection.profile
            : DEFAULT_CONFIG.analysis.unicode_detection.profile;
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
                if (value === true) {
                    passed += 1;
                } else if (value === false) {
                    failed += 1;
                } else {
                    unknown += 1;
                }
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

    /**
     * Get OS candidates for a Unicode version
     */
    getCandidates(unicodeVersion) {
        const candidates = this.db.os_candidates_by_unicode[unicodeVersion] || [];

        return candidates.map(c => ({
            ...c,
            score: 0,
            signals: {}
        }));
    }

    /**
     * Score candidates based on emoji support profile
     */
    scoreByEmojiProfile(candidates, profile) {
        const versions = Object.keys(profile.versions || {}).sort((a, b) => this.compareVersions(a, b));

        for (const candidate of candidates) {
            let match = 0;
            let mismatch = 0;
            let evaluated = 0;
            const candidateVersion = candidate.max_emoji_version || null;

            if (candidateVersion) {
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
        const hintsConfig = config && config.analysis && config.analysis.scoring && config.analysis.scoring.environment_hints
            ? config.analysis.scoring.environment_hints
            : DEFAULT_CONFIG.analysis.scoring.environment_hints;

        if (!hintsConfig || hintsConfig.enabled === false || hintsConfig.mode === 'disabled') {
            return candidates;
        }

        const uaHints = inferOsFamilyHints(diagnostics);

        const weights = hintsConfig.weights && typeof hintsConfig.weights === 'object' ? hintsConfig.weights : {};
        const UA_MATCH_BONUS = clampNumber(weights.ua_match_bonus, DEFAULT_CONFIG.analysis.scoring.environment_hints.weights.ua_match_bonus);
        const UA_MISMATCH_PENALTY = clampNumber(weights.ua_mismatch_penalty, DEFAULT_CONFIG.analysis.scoring.environment_hints.weights.ua_mismatch_penalty);
        const APPLE_CROSS_BONUS = clampNumber(weights.apple_cross_bonus, DEFAULT_CONFIG.analysis.scoring.environment_hints.weights.apple_cross_bonus);

        const mode = hintsConfig.mode;
        const maxBaseScore = mode === 'tie_break_only' && candidates.length > 0
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

                if (match) delta += UA_MATCH_BONUS;
                else if (appleCross) delta += APPLE_CROSS_BONUS;
                else delta -= UA_MISMATCH_PENALTY;

                signals.ua_family = uaHints.family;
                signals.ua_source = uaHints.source;
                signals.ua_family_match = match;
            }

            candidate.score = Math.round(candidate.score + delta);
            candidate.signals = signals;
        }

        return candidates;
    }

    /**
     * Main fingerprinting function
     */
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

        // Step 0: Guardrails (spoofing, blocked readback, tofu cluster)
        if (analysisConfig.guards?.spoofing_detected?.enabled && diagnostics && diagnostics.spoofing_detected) {
            const message = 'Canvas Spoofing Detected (Random Noise): Results Unreliable';
            const policy = analysisConfig.guards.spoofing_detected.policy || 'reject';
            if (policy === 'reject') return hardFail(message);
            if (policy === 'warn') warnings.push(message);
        }

        if (analysisConfig.guards?.canvas_blocked?.enabled && diagnostics && diagnostics.canvas_blocked) {
            const message = 'Canvas Readback Blocked: Results Unreliable';
            const policy = analysisConfig.guards.canvas_blocked.policy || 'reject';
            if (policy === 'reject') return hardFail(message);
            if (policy === 'warn') warnings.push(message);
        }

        const tofuGuard = analysisConfig.guards && analysisConfig.guards.tofu_cluster
            ? analysisConfig.guards.tofu_cluster
            : DEFAULT_CONFIG.analysis.guards.tofu_cluster;

        if (tofuGuard.enabled && diagnostics) {
            const tofuCluster = diagnostics.tofu_cluster && typeof diagnostics.tofu_cluster === 'object'
                ? diagnostics.tofu_cluster
                : null;

            const shareOk = tofuCluster && typeof tofuCluster.share === 'number'
                ? tofuCluster.share >= tofuGuard.min_share
                : true;
            const consideredOk = tofuCluster && typeof tofuCluster.considered_true_count === 'number'
                ? tofuCluster.considered_true_count >= tofuGuard.min_considered_true
                : true;
            const dominantOk = tofuCluster && typeof tofuCluster.dominant_count === 'number'
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

        // Step 1: Detect max Unicode version
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

        // Step 2: Get OS candidates
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

        // Step 3: Score by emoji support profile + environment hints
        if (analysisConfig.scoring?.emoji_profile?.enabled !== false) {
            candidates = this.scoreByEmojiProfile(candidates, emojiProfile);
        }

        if (analysisConfig.scoring?.environment_hints?.enabled && analysisConfig.scoring.environment_hints.mode !== 'disabled') {
            candidates = this.scoreByEnvironmentHints(candidates, diagnostics, cfg);
        }

        const clampMin = analysisConfig.score?.clamp && typeof analysisConfig.score.clamp.min === 'number'
            ? analysisConfig.score.clamp.min
            : DEFAULT_CONFIG.analysis.score.clamp.min;
        const clampMax = analysisConfig.score?.clamp && typeof analysisConfig.score.clamp.max === 'number'
            ? analysisConfig.score.clamp.max
            : DEFAULT_CONFIG.analysis.score.clamp.max;

        for (const candidate of candidates) {
            candidate.score = clampNumber(candidate.score, 0, { min: clampMin, max: clampMax });
        }

        // Optional narrowing: if UA-CH platform is present, restrict candidates to that OS family.
        // This prevents ties between unrelated vendors when emoji support alone is identical.
        const narrowingConfig = analysisConfig.scoring && analysisConfig.scoring.ua_ch_narrowing
            ? analysisConfig.scoring.ua_ch_narrowing
            : DEFAULT_CONFIG.analysis.scoring.ua_ch_narrowing;

        if (narrowingConfig.enabled && uaHints.source === 'ua_ch' && uaHints.family !== 'unknown') {
            const allow = new Set([uaHints.family]);
            // Apple platforms often share the same emoji set; optionally keep both families to avoid false exclusion.
            if (narrowingConfig.allow_apple_cross) {
                if (uaHints.family === 'macos') allow.add('ios');
                if (uaHints.family === 'ios') allow.add('macos');
            }

            const narrowed = candidates.filter(candidate => allow.has(this.vendorFamily(candidate.vendor)));
            if (narrowed.length > 0) candidates = narrowed;
        }

        // Step 4: Sort by score
        candidates.sort((a, b) => b.score - a.score);

        // Step 5: Calculate probabilities
        const totalScore = candidates.reduce((sum, c) => sum + Math.max(c.score, 0), 0);
        const uniform = candidates.length > 0 ? 1 / candidates.length : 0;
        candidates = candidates.map(c => ({
            ...c,
            probability: totalScore > 0 ? c.score / totalScore : uniform
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

const fingerprinter = new EmojiFingerprinter(EMOJI_DB);

// Helper: Parse request body
function parseBody(req, maxBytes = 1_000_000) {
    return new Promise((resolve, reject) => {
        let body = '';
        let bytes = 0;
        req.on('data', chunk => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
                reject(new Error('Payload too large'));
                req.destroy();
                return;
            }
            body += chunk;
        });
        req.on('end', () => {
            try {
                resolve(JSON.parse(body));
            } catch (error) {
                reject(error);
            }
        });
        req.on('error', reject);
    });
}

function validateTestResults(payload, config) {
    if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'Invalid JSON payload' };
    }

    if (!payload.sentinel_results || typeof payload.sentinel_results !== 'object' || Array.isArray(payload.sentinel_results)) {
        return { ok: false, error: 'sentinel_results must be an object' };
    }

    const maxSentinelResults = config && config.limits && typeof config.limits.max_sentinel_results === 'number'
        ? config.limits.max_sentinel_results
        : DEFAULT_CONFIG.limits.max_sentinel_results;

    let resultCount = 0;
    for (const [key, value] of Object.entries(payload.sentinel_results)) {
        if (typeof key !== 'string' || key.length === 0) {
            return { ok: false, error: 'sentinel_results keys must be non-empty strings' };
        }
        if (!(value === true || value === false || value === null)) {
            return { ok: false, error: 'sentinel_results values must be true, false, or null' };
        }
        resultCount += 1;
        if (resultCount > maxSentinelResults) {
            return { ok: false, error: 'sentinel_results too large' };
        }
    }

    if (resultCount === 0) {
        return { ok: false, error: 'sentinel_results is empty' };
    }

    if (payload.session_id && typeof payload.session_id !== 'string') {
        return { ok: false, error: 'session_id must be a string' };
    }

    if (payload.diagnostics && (typeof payload.diagnostics !== 'object' || Array.isArray(payload.diagnostics))) {
        return { ok: false, error: 'diagnostics must be an object' };
    }

    if (payload.timestamp && typeof payload.timestamp !== 'string') {
        return { ok: false, error: 'timestamp must be a string' };
    }

    return { ok: true, value: payload };
}

function inferOsFamilyFromUAChPlatform(platform) {
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

function inferOsFamilyFromUserAgent(userAgent) {
    const ua = String(userAgent || '').toLowerCase();
    if (!ua) return 'unknown';

    if (ua.includes('iphone') || ua.includes('ipad') || ua.includes('ipod')) return 'ios';
    if (ua.includes('android')) return 'android';
    if (ua.includes('windows nt')) return 'windows';
    if (ua.includes('macintosh') || ua.includes('mac os x')) return 'macos';
    if (ua.includes('linux')) return 'linux';
    return 'unknown';
}

function inferOsFamilyHints(diagnostics) {
    const uaChPlatform = diagnostics && diagnostics.user_agent_data && typeof diagnostics.user_agent_data.platform === 'string'
        ? diagnostics.user_agent_data.platform
        : null;

    const familyFromUACh = inferOsFamilyFromUAChPlatform(uaChPlatform);
    if (familyFromUACh !== 'unknown') {
        return { family: familyFromUACh, source: 'ua_ch' };
    }

    const ua = diagnostics && typeof diagnostics.user_agent === 'string' ? diagnostics.user_agent : null;
    const familyFromUA = inferOsFamilyFromUserAgent(ua);
    return { family: familyFromUA, source: familyFromUA !== 'unknown' ? 'user_agent' : 'unknown' };
}

function inferBrowserKey(diagnostics) {
    if (diagnostics && typeof diagnostics.browser_label === 'string' && diagnostics.browser_label.trim()) {
        return diagnostics.browser_label.trim();
    }

    const userAgent = diagnostics && typeof diagnostics.user_agent === 'string'
        ? diagnostics.user_agent.toLowerCase()
        : '';

    if (userAgent.includes('edg/')) return 'Edge';
    if (userAgent.includes('firefox/')) return 'Firefox';
    if (userAgent.includes('chrome/') && !userAgent.includes('edg/')) return 'Chrome';
    if (userAgent.includes('safari/') && !userAgent.includes('chrome/')) return 'Safari';
    return 'unknown_browser';
}

// Helper: Send JSON response
function applyCorsHeaders(res, req, config, { preflight = false } = {}) {
    if (!config || !config.cors || config.cors.enabled !== true) return;

    const originHeader = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const allowOrigin = config.cors.allow_origin;

    if (allowOrigin === '*') {
        res.setHeader('Access-Control-Allow-Origin', '*');
    } else if (typeof allowOrigin === 'string' && allowOrigin.trim()) {
        if (!originHeader) {
            res.setHeader('Access-Control-Allow-Origin', allowOrigin);
        } else if (originHeader === allowOrigin) {
            res.setHeader('Access-Control-Allow-Origin', originHeader);
            res.setHeader('Vary', 'Origin');
        }
    } else if (Array.isArray(config.cors.allow_origins)) {
        const allowed = config.cors.allow_origins.filter(value => typeof value === 'string' && value.trim());
        if (originHeader && allowed.includes(originHeader)) {
            res.setHeader('Access-Control-Allow-Origin', originHeader);
            res.setHeader('Vary', 'Origin');
        }
    }

    const methods = Array.isArray(config.cors.allow_methods) ? config.cors.allow_methods : DEFAULT_CONFIG.cors.allow_methods;
    const headers = Array.isArray(config.cors.allow_headers) ? config.cors.allow_headers : DEFAULT_CONFIG.cors.allow_headers;

    res.setHeader('Access-Control-Allow-Methods', methods.join(', '));
    res.setHeader('Access-Control-Allow-Headers', headers.join(', '));

    if (preflight) {
        const maxAge = clampNumber(config.cors.max_age_seconds, DEFAULT_CONFIG.cors.max_age_seconds, { min: 0, max: 86_400 });
        res.setHeader('Access-Control-Max-Age', String(maxAge));
    }
}

function applySecurityHeaders(res, config) {
    if (!config || !config.security_headers || config.security_headers.enabled !== true) return;

    if (typeof config.security_headers.cache_control === 'string' && config.security_headers.cache_control.trim()) {
        res.setHeader('Cache-Control', config.security_headers.cache_control.trim());
    }
    if (typeof config.security_headers.referrer_policy === 'string' && config.security_headers.referrer_policy.trim()) {
        res.setHeader('Referrer-Policy', config.security_headers.referrer_policy.trim());
    }
    if (config.security_headers.x_content_type_options) {
        res.setHeader('X-Content-Type-Options', 'nosniff');
    }
    if (typeof config.security_headers.x_frame_options === 'string' && config.security_headers.x_frame_options.trim()) {
        res.setHeader('X-Frame-Options', config.security_headers.x_frame_options.trim());
    }
    if (typeof config.security_headers.cross_origin_opener_policy === 'string' && config.security_headers.cross_origin_opener_policy.trim()) {
        res.setHeader('Cross-Origin-Opener-Policy', config.security_headers.cross_origin_opener_policy.trim());
    }
    if (typeof config.security_headers.cross_origin_resource_policy === 'string' && config.security_headers.cross_origin_resource_policy.trim()) {
        res.setHeader('Cross-Origin-Resource-Policy', config.security_headers.cross_origin_resource_policy.trim());
    }
}

function sendJSON(res, status, data, config, req) {
    const cfg = config || getRuntimeConfig();
    if (req) applyCorsHeaders(res, req, cfg);
    applySecurityHeaders(res, cfg);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
}

function sendText(res, status, text, config, req) {
    const cfg = config || getRuntimeConfig();
    if (req) applyCorsHeaders(res, req, cfg);
    applySecurityHeaders(res, cfg);
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(text || ''));
}

function sendEmpty(res, status, config, req) {
    const cfg = config || getRuntimeConfig();
    if (req) applyCorsHeaders(res, req, cfg);
    applySecurityHeaders(res, cfg);
    res.writeHead(status);
    res.end();
}

function sendDisabled(res, config, req) {
    const cfg = config || getRuntimeConfig();
    const response = cfg.service && cfg.service.disabled_response ? cfg.service.disabled_response : DEFAULT_CONFIG.service.disabled_response;
    const status = clampNumber(response.status, DEFAULT_CONFIG.service.disabled_response.status, { min: 100, max: 599 });

    if (response.mode === 'json') return sendJSON(res, status, response.json || { success: false, error: 'disabled' }, cfg, req);
    if (response.mode === 'text') return sendText(res, status, response.text || 'disabled', cfg, req);
    return sendEmpty(res, status, cfg, req);
}

// Helper: Serve static files
function serveStatic(res, filePath, contentType, config, req) {
    try {
        const content = fs.readFileSync(filePath, contentType.includes('text') ? 'utf8' : null);
        const cfg = config || getRuntimeConfig();
        if (req) applyCorsHeaders(res, req, cfg);
        applySecurityHeaders(res, cfg);
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
    } catch (error) {
        sendText(res, 404, 'Not found', config, req);
    }
}

// Save persistent database (debounced, async)
let saveTimer = null;
let savePending = false;

function scheduleSavePersistentDB(config) {
    const cfg = config || getRuntimeConfig();
    if (!cfg.storage || !cfg.storage.persistence || cfg.storage.persistence.enabled !== true) return;

    if (saveTimer) {
        savePending = true;
        return;
    }

    const delayMs = clampNumber(
        cfg.storage.persistence.save_debounce_ms,
        DEFAULT_CONFIG.storage.persistence.save_debounce_ms,
        { min: 0, max: 60_000 }
    );

    saveTimer = setTimeout(async () => {
        saveTimer = null;

        const latestConfig = getRuntimeConfig();
        if (!latestConfig.storage || !latestConfig.storage.persistence || latestConfig.storage.persistence.enabled !== true) {
            savePending = false;
            return;
        }

        try {
            await fs.promises.writeFile(DB_PATH, JSON.stringify(persistentDB, null, 2), 'utf8');
        } catch (error) {
            console.error('Error saving database:', error);
        }

        if (savePending) {
            savePending = false;
            scheduleSavePersistentDB(latestConfig);
        }
    }, delayMs);
}

const rateLimitBuckets = new Map();

function getClientIp(req, config) {
    const trustProxy = Boolean(config && config.server && config.server.trust_proxy);
    const forwardedFor = trustProxy && typeof req.headers['x-forwarded-for'] === 'string'
        ? req.headers['x-forwarded-for']
        : null;
    if (forwardedFor) {
        const first = forwardedFor.split(',')[0]?.trim();
        if (first) return first;
    }

    const realIp = trustProxy && typeof req.headers['x-real-ip'] === 'string' ? req.headers['x-real-ip'].trim() : '';
    if (realIp) return realIp;

    const remote = req.socket && typeof req.socket.remoteAddress === 'string' ? req.socket.remoteAddress : '';
    return remote || 'unknown';
}

function getRateLimitKey(req, config) {
    const mode = config && config.rate_limit ? config.rate_limit.key : 'ip';
    if (mode === 'header') {
        const headerName = typeof config.rate_limit.header_name === 'string' && config.rate_limit.header_name.trim()
            ? config.rate_limit.header_name.trim().toLowerCase()
            : 'x-rate-limit-key';
        const value = req.headers[headerName];
        if (typeof value === 'string' && value.trim()) return value.trim();
        if (Array.isArray(value) && typeof value[0] === 'string' && value[0].trim()) return value[0].trim();
    }

    return getClientIp(req, config);
}

function checkRateLimit(req, config) {
    if (!config.rate_limit || config.rate_limit.enabled !== true) return { ok: true };

    const key = getRateLimitKey(req, config);
    const now = Date.now();
    const windowMs = clampNumber(config.rate_limit.window_ms, DEFAULT_CONFIG.rate_limit.window_ms, { min: 100, max: 3_600_000 });
    const maxRequests = clampNumber(config.rate_limit.max_requests, DEFAULT_CONFIG.rate_limit.max_requests, { min: 1, max: 1_000_000 });

    const bucket = rateLimitBuckets.get(key);
    if (!bucket || now - bucket.window_start_ms >= windowMs) {
        rateLimitBuckets.set(key, { window_start_ms: now, count: 1 });
        return { ok: true };
    }

    bucket.count += 1;
    if (bucket.count <= maxRequests) return { ok: true };

    const retryAfterMs = bucket.window_start_ms + windowMs - now;
    return { ok: false, retry_after_ms: Math.max(0, retryAfterMs) };
}

function getExpectedAdminToken(config) {
    const adminConfig = config && config.auth && config.auth.admin ? config.auth.admin : DEFAULT_CONFIG.auth.admin;
    if (adminConfig.value && typeof adminConfig.value === 'string' && adminConfig.value.trim()) {
        return adminConfig.value.trim();
    }
    if (adminConfig.env && typeof adminConfig.env === 'string' && adminConfig.env.trim()) {
        const value = process.env[adminConfig.env.trim()];
        if (typeof value === 'string' && value.trim()) return value.trim();
    }
    return null;
}

function extractRequestToken(req, url, config) {
    const requestConfig = config && config.auth && config.auth.request ? config.auth.request : DEFAULT_CONFIG.auth.request;
    const headerName = typeof requestConfig.header === 'string' && requestConfig.header.trim()
        ? requestConfig.header.trim().toLowerCase()
        : DEFAULT_CONFIG.auth.request.header.toLowerCase();

    const headerValue = req.headers[headerName];
    let token = typeof headerValue === 'string' ? headerValue : Array.isArray(headerValue) ? headerValue[0] : null;

    if (typeof token === 'string' && requestConfig.allow_bearer_prefix) {
        const lower = token.toLowerCase();
        if (lower.startsWith('bearer ')) token = token.slice(7);
    }

    if ((!token || !String(token).trim()) && requestConfig.query_param) {
        const queryValue = url.searchParams.get(requestConfig.query_param);
        if (queryValue) token = queryValue;
    }

    return typeof token === 'string' && token.trim() ? token.trim() : null;
}

function requireAdmin(req, res, url, config) {
    const expected = getExpectedAdminToken(config);
    if (!expected) {
        sendJSON(res, 401, { error: 'Admin token not configured' }, config, req);
        return false;
    }

    const token = extractRequestToken(req, url, config);
    if (token !== expected) {
        sendJSON(res, 401, { error: 'Unauthorized' }, config, req);
        return false;
    }

    return true;
}

function evictOldestEntries(map, count) {
    if (count <= 0) return;
    const iterator = map.keys();
    for (let i = 0; i < count; i++) {
        const next = iterator.next();
        if (next.done) break;
        map.delete(next.value);
    }
}

function storeSession(sessionId, entry, config) {
    if (!config.storage || !config.storage.session_store || config.storage.session_store.enabled !== true) return;

    sessionStore.set(sessionId, entry);

    const maxEntries = config.limits ? config.limits.max_session_store_entries : DEFAULT_CONFIG.limits.max_session_store_entries;
    if (typeof maxEntries === 'number' && maxEntries > 0 && sessionStore.size > maxEntries) {
        evictOldestEntries(sessionStore, sessionStore.size - maxEntries);
    }
}

function getSession(sessionId, config) {
    if (!config.storage || !config.storage.session_store || config.storage.session_store.enabled !== true) return null;
    if (!sessionId || !sessionStore.has(sessionId)) return null;

    const ttlMs = config.storage.session_store.ttl_ms;
    if (typeof ttlMs === 'number' && ttlMs > 0) {
        const entry = sessionStore.get(sessionId);
        const createdAtMs = entry && typeof entry.created_at_ms === 'number'
            ? entry.created_at_ms
            : entry && typeof entry.timestamp === 'string'
                ? Date.parse(entry.timestamp)
                : NaN;

        if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > ttlMs) {
            sessionStore.delete(sessionId);
            return null;
        }
    }

    return sessionStore.get(sessionId);
}

// HTTP Server
const server = http.createServer(async (req, res) => {
    const config = getRuntimeConfig();

    const hostHeader = typeof req.headers.host === 'string' && req.headers.host.trim()
        ? req.headers.host.trim()
        : `localhost:${PORT}`;
    const url = new URL(req.url, `http://${hostHeader}`);

    const requestStartMs = Date.now();
    if (config.logging && config.logging.requests && config.logging.requests.enabled) {
        const ip = config.logging.requests.include_ip ? getClientIp(req, config) : null;
        const ua = config.logging.requests.include_user_agent && typeof req.headers['user-agent'] === 'string'
            ? req.headers['user-agent']
            : null;

        res.on('finish', () => {
            const elapsed = Date.now() - requestStartMs;
            const parts = [
                `${req.method} ${url.pathname}`,
                String(res.statusCode),
                `${elapsed}ms`
            ];
            if (ip) parts.push(`ip=${ip}`);
            if (ua) parts.push(`ua=${ua}`);
            console.log(parts.join(' '));
        });
    }

    // CORS preflight
    if (req.method === 'OPTIONS') {
        applyCorsHeaders(res, req, config, { preflight: true });
        applySecurityHeaders(res, config);
        sendEmpty(res, 204, config, req);
        return;
    }

    // Global kill switch
    if (!config.service || config.service.enabled !== true) {
        sendDisabled(res, config, req);
        return;
    }

    // Rate limiting
    const rateLimit = checkRateLimit(req, config);
    if (!rateLimit.ok) {
        res.setHeader('Retry-After', String(Math.ceil(rateLimit.retry_after_ms / 1000)));
        sendJSON(res, 429, { error: 'Rate limited', retry_after_ms: rateLimit.retry_after_ms }, config, req);
        return;
    }

    // Routes
    if (url.pathname === '/' && req.method === 'GET') {
        if (!config.endpoints || !config.endpoints.ui || config.endpoints.ui.enabled !== true) {
            sendDisabled(res, config, req);
            return;
        }
        serveStatic(res, path.join(__dirname, 'public', 'client.html'), 'text/html', config, req);
        return;
    }

    if (url.pathname === '/api/health' && req.method === 'GET') {
        if (!config.endpoints || !config.endpoints.health || config.endpoints.health.enabled !== true) {
            sendDisabled(res, config, req);
            return;
        }
        sendJSON(res, 200, {
            ok: true,
            service_enabled: Boolean(config.service && config.service.enabled),
            analysis_enabled: Boolean(config.analysis && config.analysis.enabled),
            persistence_enabled: Boolean(config.storage && config.storage.persistence && config.storage.persistence.enabled),
            session_store_enabled: Boolean(config.storage && config.storage.session_store && config.storage.session_store.enabled)
        }, config, req);
        return;
    }

    if (url.pathname === '/api/config' && req.method === 'GET') {
        if (!config.endpoints || !config.endpoints.config || config.endpoints.config.enabled !== true) {
            sendDisabled(res, config, req);
            return;
        }
        sendJSON(res, 200, {
            service: { enabled: Boolean(config.service && config.service.enabled) },
            endpoints: config.endpoints || {},
            analysis: {
                enabled: Boolean(config.analysis && config.analysis.enabled),
                guards: config.analysis && config.analysis.guards ? {
                    tofu_cluster: config.analysis.guards.tofu_cluster || null
                } : null,
                unicode_detection: config.analysis && config.analysis.unicode_detection ? {
                    version_filter: config.analysis.unicode_detection.version_filter || null,
                    sentinels: config.analysis.unicode_detection.sentinels || null,
                    profile: config.analysis.unicode_detection.profile || null
                } : null,
                scoring: config.analysis && config.analysis.scoring ? {
                    environment_hints: {
                        enabled: Boolean(config.analysis.scoring.environment_hints && config.analysis.scoring.environment_hints.enabled),
                        mode: config.analysis.scoring.environment_hints ? config.analysis.scoring.environment_hints.mode : null
                    },
                    ua_ch_narrowing: {
                        enabled: Boolean(config.analysis.scoring.ua_ch_narrowing && config.analysis.scoring.ua_ch_narrowing.enabled)
                    }
                } : null
            },
            client: config.client || {}
        }, config, req);
        return;
    }

    if (url.pathname === '/api/test' && req.method === 'POST') {
        if (!config.endpoints || !config.endpoints.test || config.endpoints.test.enabled !== true) {
            sendDisabled(res, config, req);
            return;
        }

        try {
            const rawResults = await parseBody(req, config.limits ? config.limits.max_body_bytes : DEFAULT_CONFIG.limits.max_body_bytes);
            const validation = validateTestResults(rawResults, config);
            if (!validation.ok) {
                sendJSON(res, 400, { error: validation.error }, config, req);
                return;
            }

            const testResults = validation.value;
            const diagnostics = testResults.diagnostics && typeof testResults.diagnostics === 'object'
                ? { ...testResults.diagnostics }
                : {};

            if (!diagnostics.user_agent && typeof testResults.user_agent === 'string') {
                diagnostics.user_agent = testResults.user_agent;
            }

            const sessionId = typeof testResults.session_id === 'string' && testResults.session_id.trim()
                ? testResults.session_id.trim()
                : `session_${Date.now()}`;

            const analysis = config.analysis && config.analysis.enabled === true
                ? fingerprinter.analyze({ ...testResults, diagnostics }, config)
                : null;

            // Store in session store (in-memory)
            storeSession(sessionId, {
                testResults: { ...testResults, diagnostics },
                analysis,
                timestamp: new Date().toISOString(),
                created_at_ms: Date.now()
            }, config);

            // Store in persistent DB (structured by device/browser)
            if (config.storage && config.storage.persistence && config.storage.persistence.enabled === true) {
                const deviceKey = analysis && analysis.top_match
                    ? `${analysis.top_match.vendor}_${analysis.top_match.os_version}`
                    : 'unknown_device';

                if (!persistentDB.devices[deviceKey]) {
                    persistentDB.devices[deviceKey] = {
                        device_key: deviceKey,
                        browsers: {}
                    };
                }

                const browserKey = inferBrowserKey(diagnostics);
                if (!persistentDB.devices[deviceKey].browsers[browserKey]) {
                    persistentDB.devices[deviceKey].browsers[browserKey] = {
                        browser_key: browserKey,
                        sessions: []
                    };
                }

                const deviceBrowserSessions = persistentDB.devices[deviceKey].browsers[browserKey].sessions;
                const sessionRecord = {
                    session_id: sessionId,
                    timestamp: new Date().toISOString()
                };

                if (config.storage.persistence.store_analysis) sessionRecord.analysis = analysis;
                if (config.storage.persistence.store_diagnostics) sessionRecord.diagnostics = diagnostics || null;

                deviceBrowserSessions.push(sessionRecord);

                const maxPer = config.storage.persistence.max_sessions_per_device_browser;
                if (typeof maxPer === 'number' && maxPer > 0 && deviceBrowserSessions.length > maxPer) {
                    deviceBrowserSessions.splice(0, deviceBrowserSessions.length - maxPer);
                }

                const persistentSession = {};
                if (config.storage.persistence.store_raw_test_results) {
                    persistentSession.testResults = { ...testResults, diagnostics };
                } else {
                    const count = testResults.sentinel_results && typeof testResults.sentinel_results === 'object'
                        ? Object.keys(testResults.sentinel_results).length
                        : 0;
                    persistentSession.testResults = { session_id: sessionId, timestamp: testResults.timestamp || null, sentinel_result_count: count };
                    if (config.storage.persistence.store_diagnostics) {
                        persistentSession.diagnostics = diagnostics || null;
                    }
                }

                if (config.storage.persistence.store_analysis) persistentSession.analysis = analysis;

                persistentDB.sessions[sessionId] = persistentSession;

                scheduleSavePersistentDB(config);
            }

            const responseMode = config.endpoints.test.response_mode || 'full';

            if (responseMode === 'none') {
                sendEmpty(res, 204, config, req);
                return;
            }

            if (responseMode === 'ack') {
                sendJSON(res, 200, { success: true, session_id: sessionId }, config, req);
                return;
            }

            if (responseMode === 'minimal') {
                const minimal = analysis ? {
                    unicode_version: analysis.unicode_version ? {
                        version: analysis.unicode_version.version,
                        confidence: analysis.unicode_version.confidence,
                        method: analysis.unicode_version.method
                    } : null,
                    top_match: analysis.top_match ? {
                        vendor: analysis.top_match.vendor,
                        os_version: analysis.top_match.os_version,
                        max_emoji_version: analysis.top_match.max_emoji_version,
                        probability: analysis.top_match.probability,
                        score: analysis.top_match.score
                    } : null,
                    confidence: analysis.confidence,
                    error: analysis.error,
                    warnings: analysis.warnings,
                    timestamp: analysis.timestamp
                } : null;

                sendJSON(res, 200, { success: true, session_id: sessionId, analysis: minimal }, config, req);
                return;
            }

            sendJSON(res, 200, { success: true, session_id: sessionId, analysis }, config, req);
        } catch (error) {
            sendJSON(res, 400, { error: error.message }, config, req);
        }
        return;
    }

    if (url.pathname === '/api/fingerprint' && req.method === 'GET') {
        if (!config.endpoints || !config.endpoints.fingerprint || config.endpoints.fingerprint.enabled !== true) {
            sendDisabled(res, config, req);
            return;
        }

        const sessionId = url.searchParams.get('session_id');
        const entry = sessionId ? getSession(sessionId, config) : null;

        if (entry) {
            sendJSON(res, 200, entry, config, req);
        } else {
            sendJSON(res, 404, { error: 'Session not found' }, config, req);
        }
        return;
    }

    if (url.pathname === '/api/database' && req.method === 'GET') {
        if (!config.endpoints || !config.endpoints.database || config.endpoints.database.enabled !== true) {
            sendDisabled(res, config, req);
            return;
        }

        if (config.endpoints.database.require_admin || (config.auth && config.auth.admin && config.auth.admin.enabled)) {
            if (!requireAdmin(req, res, url, config)) return;
        }

        sendJSON(res, 200, persistentDB, config, req);
        return;
    }

    if (url.pathname === '/api/sentinels' && req.method === 'GET') {
        if (!config.endpoints || !config.endpoints.sentinels || config.endpoints.sentinels.enabled !== true) {
            sendDisabled(res, config, req);
            return;
        }

        const sentinels = {};
        const allowVersion = buildUnicodeVersionPredicate(config);
        const sentinelsConfig = config.analysis && config.analysis.unicode_detection && config.analysis.unicode_detection.sentinels
            ? config.analysis.unicode_detection.sentinels
            : DEFAULT_CONFIG.analysis.unicode_detection.sentinels;
        const omitEmpty = sentinelsConfig.omit_empty_versions !== false;

        const versions = fingerprinter.getSortedVersions(false, config);
        for (const version of versions) {
            if (!allowVersion(version)) continue;
            const data = EMOJI_DB.unicode_versions[version];
            if (!data) continue;
            const list = Array.isArray(data.sentinel_emojis) ? data.sentinel_emojis : [];
            if (omitEmpty && list.length === 0) continue;
            sentinels[version] = list.map(emoji => ({ char: emoji.char, name: emoji.name }));
        }
        sendJSON(res, 200, sentinels, config, req);
        return;
    }

    sendText(res, 404, 'Not found', config, req);
});

server.requestTimeout = STARTUP_CONFIG.server.request_timeout_ms;

server.listen(PORT, HOST, () => {
    const baseUrl = HOST === '0.0.0.0' ? `http://localhost:${PORT}` : `http://${HOST}:${PORT}`;
    console.log(`\n🚀 Emoji Fingerprinting Server running on ${baseUrl}\n`);
    console.log('API Endpoints:');
    console.log('  POST   /api/test         - Submit emoji test results');
    console.log('  GET    /api/fingerprint  - Get fingerprint by session_id');
    console.log('  GET    /api/database     - Get all stored fingerprints');
    console.log('  GET    /api/sentinels    - Get sentinel emoji lists');
    console.log('  GET    /api/health       - Health check');
    console.log('  GET    /api/config       - Public runtime config');
    console.log('  GET    /                 - Test UI\n');
});
