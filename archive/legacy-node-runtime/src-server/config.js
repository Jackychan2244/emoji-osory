import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export const REPO_ROOT = path.resolve(MODULE_DIR, '..', '..');

export const DEFAULT_CONFIG = {
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

export const CONFIG_PATH = process.env.EMOJI_FP_CONFIG_PATH
    ? path.resolve(process.env.EMOJI_FP_CONFIG_PATH)
    : path.join(REPO_ROOT, 'config.json');

export function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function deepMerge(base, override) {
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

export function clampNumber(value, fallback, { min = -Infinity, max = Infinity } = {}) {
    const numberValue = typeof value === 'number' ? value : Number(value);
    if (!Number.isFinite(numberValue)) return fallback;
    return Math.max(min, Math.min(max, numberValue));
}

function normalizeEndpointConfig(endpoints) {
    const normalized = endpoints && typeof endpoints === 'object' ? endpoints : DEFAULT_CONFIG.endpoints;

    for (const [key, defaultValue] of Object.entries(DEFAULT_CONFIG.endpoints)) {
        const endpoint = normalized[key] && typeof normalized[key] === 'object' ? normalized[key] : {};
        endpoint.enabled = typeof endpoint.enabled === 'boolean' ? endpoint.enabled : defaultValue.enabled;
        normalized[key] = endpoint;
    }

    normalized.test.response_mode = ['full', 'minimal', 'ack', 'none'].includes(normalized.test.response_mode)
        ? normalized.test.response_mode
        : DEFAULT_CONFIG.endpoints.test.response_mode;
    normalized.database.require_admin = Boolean(normalized.database.require_admin);

    return normalized;
}

export function normalizeConfig(rawConfig) {
    const merged = deepMerge(DEFAULT_CONFIG, isPlainObject(rawConfig) ? rawConfig : {});

    merged.schema_version = clampNumber(merged.schema_version, DEFAULT_CONFIG.schema_version, { min: 1, max: 1_000_000 });

    merged.service.enabled = Boolean(merged.service.enabled);
    merged.service.disabled_response = isPlainObject(merged.service.disabled_response)
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
    merged.rate_limit.key = merged.rate_limit.key === 'ip' || merged.rate_limit.key === 'header'
        ? merged.rate_limit.key
        : DEFAULT_CONFIG.rate_limit.key;

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

    merged.endpoints = normalizeEndpointConfig(merged.endpoints);

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

    const versionFilter = isPlainObject(merged.analysis.unicode_detection.version_filter)
        ? merged.analysis.unicode_detection.version_filter
        : DEFAULT_CONFIG.analysis.unicode_detection.version_filter;
    versionFilter.mode = ['none', 'include', 'exclude'].includes(versionFilter.mode)
        ? versionFilter.mode
        : DEFAULT_CONFIG.analysis.unicode_detection.version_filter.mode;
    versionFilter.versions = Array.isArray(versionFilter.versions)
        ? versionFilter.versions.map(String)
        : DEFAULT_CONFIG.analysis.unicode_detection.version_filter.versions;
    merged.analysis.unicode_detection.version_filter = versionFilter;

    merged.analysis.unicode_detection.sentinels = isPlainObject(merged.analysis.unicode_detection.sentinels)
        ? merged.analysis.unicode_detection.sentinels
        : DEFAULT_CONFIG.analysis.unicode_detection.sentinels;
    merged.analysis.unicode_detection.sentinels.omit_empty_versions = Boolean(merged.analysis.unicode_detection.sentinels.omit_empty_versions);

    merged.analysis.unicode_detection.profile = isPlainObject(merged.analysis.unicode_detection.profile)
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

export function buildUnicodeVersionPredicate(config) {
    const filter = config?.analysis?.unicode_detection?.version_filter || DEFAULT_CONFIG.analysis.unicode_detection.version_filter;

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

export function getRuntimeConfig() {
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

export function resolveRepoPath(value) {
    if (typeof value !== 'string' || !value.trim()) return null;
    const trimmed = value.trim();
    return path.isAbsolute(trimmed) ? trimmed : path.join(REPO_ROOT, trimmed);
}
