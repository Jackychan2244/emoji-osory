import http from 'http';
import fs from 'fs';
import path from 'path';

import { DEFAULT_CONFIG, REPO_ROOT, buildUnicodeVersionPredicate, clampNumber, getRuntimeConfig, resolveRepoPath } from './config.js';
import { EmojiFingerprinter, inferBrowserKey } from './fingerprinter.js';
import { applyCorsHeaders, applySecurityHeaders, parseBody, sendDisabled, sendEmpty, sendJSON, sendText, serveStatic, validateTestResults } from './http.js';

const STARTUP_CONFIG = getRuntimeConfig();
const HOST = process.env.HOST || STARTUP_CONFIG.server.host;
const PORT = clampNumber(process.env.PORT, STARTUP_CONFIG.server.port, { min: 1, max: 65535 });
const PUBLIC_DIR = path.join(REPO_ROOT, 'public');
const DB_PATH = resolveRepoPath(STARTUP_CONFIG.storage.persistence.path) || path.join(REPO_ROOT, 'data', 'fingerprints.json');
const EMOJI_DB_PATH = resolveRepoPath(STARTUP_CONFIG.data?.emoji_db_path) || path.join(REPO_ROOT, 'data', 'emoji-fingerprint-db.json');

const sessionStore = new Map();
const rateLimitBuckets = new Map();

let EMOJI_DB = null;
try {
    EMOJI_DB = JSON.parse(fs.readFileSync(EMOJI_DB_PATH, 'utf8'));
    console.log('✓ Loaded emoji database');
} catch {
    console.error('⚠ Warning: Could not load emoji database. Run build-master-database.js first.');
    EMOJI_DB = { unicode_versions: {}, vendors: {}, os_candidates_by_unicode: {} };
}

function normalizePersistentDB(db) {
    const normalized = db && typeof db === 'object' ? db : {};
    if (!normalized.schema_version) normalized.schema_version = 1;
    if (!normalized.sessions || typeof normalized.sessions !== 'object') normalized.sessions = {};
    if (!normalized.devices || typeof normalized.devices !== 'object') normalized.devices = {};

    for (const [deviceKey, deviceValue] of Object.entries(normalized.devices)) {
        if (deviceValue?.browsers) continue;

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

let persistentDB = { schema_version: 1, sessions: {}, devices: {} };
if (STARTUP_CONFIG.storage.persistence.enabled && fs.existsSync(DB_PATH)) {
    try {
        persistentDB = JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
        const sessionCount = persistentDB.sessions && typeof persistentDB.sessions === 'object'
            ? Object.keys(persistentDB.sessions).length
            : 0;
        console.log(`✓ Loaded ${sessionCount} fingerprints from disk`);
    } catch {
        console.error('⚠ Could not load fingerprints.json, starting fresh');
    }
}
persistentDB = normalizePersistentDB(persistentDB);

const fingerprinter = new EmojiFingerprinter(EMOJI_DB);

let saveTimer = null;
let savePending = false;

function scheduleSavePersistentDB(config) {
    const cfg = config || getRuntimeConfig();
    if (!cfg.storage?.persistence || cfg.storage.persistence.enabled !== true) return;

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
        if (!latestConfig.storage?.persistence || latestConfig.storage.persistence.enabled !== true) {
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

function getClientIp(req, config) {
    const trustProxy = Boolean(config?.server?.trust_proxy);
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
    const mode = config?.rate_limit?.key || 'ip';
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
    const adminConfig = config?.auth?.admin || DEFAULT_CONFIG.auth.admin;
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
    const requestConfig = config?.auth?.request || DEFAULT_CONFIG.auth.request;
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
    if (!config.storage?.session_store || config.storage.session_store.enabled !== true) return;
    sessionStore.set(sessionId, entry);

    const maxEntries = config.limits ? config.limits.max_session_store_entries : DEFAULT_CONFIG.limits.max_session_store_entries;
    if (typeof maxEntries === 'number' && maxEntries > 0 && sessionStore.size > maxEntries) {
        evictOldestEntries(sessionStore, sessionStore.size - maxEntries);
    }
}

function getSession(sessionId, config) {
    if (!config.storage?.session_store || config.storage.session_store.enabled !== true) return null;
    if (!sessionId || !sessionStore.has(sessionId)) return null;

    const ttlMs = config.storage.session_store.ttl_ms;
    if (typeof ttlMs === 'number' && ttlMs > 0) {
        const entry = sessionStore.get(sessionId);
        const createdAtMs = typeof entry?.created_at_ms === 'number'
            ? entry.created_at_ms
            : entry?.timestamp
                ? Date.parse(entry.timestamp)
                : NaN;

        if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs > ttlMs) {
            sessionStore.delete(sessionId);
            return null;
        }
    }

    return sessionStore.get(sessionId);
}

function sendConfig(res, req, config) {
    sendJSON(res, 200, {
        service: { enabled: Boolean(config.service && config.service.enabled) },
        endpoints: config.endpoints || {},
        analysis: {
            enabled: Boolean(config.analysis && config.analysis.enabled),
            guards: config.analysis?.guards ? {
                tofu_cluster: config.analysis.guards.tofu_cluster || null
            } : null,
            unicode_detection: config.analysis?.unicode_detection ? {
                version_filter: config.analysis.unicode_detection.version_filter || null,
                sentinels: config.analysis.unicode_detection.sentinels || null,
                profile: config.analysis.unicode_detection.profile || null
            } : null,
            scoring: config.analysis?.scoring ? {
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
}

function buildSentinelsPayload(config) {
    const sentinels = {};
    const allowVersion = buildUnicodeVersionPredicate(config);
    const sentinelsConfig = config.analysis?.unicode_detection?.sentinels || DEFAULT_CONFIG.analysis.unicode_detection.sentinels;
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

    return sentinels;
}

function resolveStaticPath(pathname) {
    if (pathname === '/' || pathname === '/index.html' || pathname === '/client.html') {
        return path.join(PUBLIC_DIR, 'index.html');
    }

    if (!pathname.startsWith('/assets/')) return null;
    const localPath = path.normalize(path.join(PUBLIC_DIR, pathname));
    if (!localPath.startsWith(PUBLIC_DIR)) return null;
    return localPath;
}

function createRequestLogger(req, res, url, config) {
    if (!config.logging?.requests?.enabled) return;

    const requestStartMs = Date.now();
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

function storePersistentRecord(sessionId, testResults, diagnostics, analysis, config) {
    if (!config.storage?.persistence || config.storage.persistence.enabled !== true) return;

    const deviceKey = analysis?.top_match
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

function handleTestResponse(res, req, config, sessionId, analysis) {
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
}

export function createServer() {
    const server = http.createServer(async (req, res) => {
        const config = getRuntimeConfig();
        const hostHeader = typeof req.headers.host === 'string' && req.headers.host.trim()
            ? req.headers.host.trim()
            : `localhost:${PORT}`;
        const url = new URL(req.url, `http://${hostHeader}`);

        createRequestLogger(req, res, url, config);

        if (req.method === 'OPTIONS') {
            applyCorsHeaders(res, req, config, { preflight: true });
            applySecurityHeaders(res, config);
            sendEmpty(res, 204, config, req);
            return;
        }

        if (!config.service || config.service.enabled !== true) {
            sendDisabled(res, config, req);
            return;
        }

        const rateLimit = checkRateLimit(req, config);
        if (!rateLimit.ok) {
            res.setHeader('Retry-After', String(Math.ceil(rateLimit.retry_after_ms / 1000)));
            sendJSON(res, 429, { error: 'Rate limited', retry_after_ms: rateLimit.retry_after_ms }, config, req);
            return;
        }

        if (req.method === 'GET' || req.method === 'HEAD') {
            const staticPath = resolveStaticPath(url.pathname);
            if (staticPath) {
                if (!config.endpoints?.ui || config.endpoints.ui.enabled !== true) {
                    sendDisabled(res, config, req);
                    return;
                }
                serveStatic(res, staticPath, config, req);
                return;
            }
        }

        if (url.pathname === '/api/health' && req.method === 'GET') {
            if (!config.endpoints?.health || config.endpoints.health.enabled !== true) {
                sendDisabled(res, config, req);
                return;
            }

            sendJSON(res, 200, {
                ok: true,
                service_enabled: Boolean(config.service && config.service.enabled),
                analysis_enabled: Boolean(config.analysis && config.analysis.enabled),
                persistence_enabled: Boolean(config.storage?.persistence && config.storage.persistence.enabled),
                session_store_enabled: Boolean(config.storage?.session_store && config.storage.session_store.enabled)
            }, config, req);
            return;
        }

        if (url.pathname === '/api/config' && req.method === 'GET') {
            if (!config.endpoints?.config || config.endpoints.config.enabled !== true) {
                sendDisabled(res, config, req);
                return;
            }
            sendConfig(res, req, config);
            return;
        }

        if (url.pathname === '/api/test' && req.method === 'POST') {
            if (!config.endpoints?.test || config.endpoints.test.enabled !== true) {
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

                const analysis = config.analysis?.enabled === true
                    ? fingerprinter.analyze({ ...testResults, diagnostics }, config)
                    : null;

                storeSession(sessionId, {
                    testResults: { ...testResults, diagnostics },
                    analysis,
                    timestamp: new Date().toISOString(),
                    created_at_ms: Date.now()
                }, config);

                storePersistentRecord(sessionId, testResults, diagnostics, analysis, config);
                handleTestResponse(res, req, config, sessionId, analysis);
            } catch (error) {
                sendJSON(res, 400, { error: error.message }, config, req);
            }
            return;
        }

        if (url.pathname === '/api/fingerprint' && req.method === 'GET') {
            if (!config.endpoints?.fingerprint || config.endpoints.fingerprint.enabled !== true) {
                sendDisabled(res, config, req);
                return;
            }

            const sessionId = url.searchParams.get('session_id');
            const entry = sessionId ? getSession(sessionId, config) : null;

            if (entry) sendJSON(res, 200, entry, config, req);
            else sendJSON(res, 404, { error: 'Session not found' }, config, req);
            return;
        }

        if (url.pathname === '/api/database' && req.method === 'GET') {
            if (!config.endpoints?.database || config.endpoints.database.enabled !== true) {
                sendDisabled(res, config, req);
                return;
            }

            if (config.endpoints.database.require_admin || (config.auth?.admin?.enabled)) {
                if (!requireAdmin(req, res, url, config)) return;
            }

            sendJSON(res, 200, persistentDB, config, req);
            return;
        }

        if (url.pathname === '/api/sentinels' && req.method === 'GET') {
            if (!config.endpoints?.sentinels || config.endpoints.sentinels.enabled !== true) {
                sendDisabled(res, config, req);
                return;
            }

            sendJSON(res, 200, buildSentinelsPayload(config), config, req);
            return;
        }

        sendText(res, 404, 'Not found', config, req);
    });

    server.requestTimeout = STARTUP_CONFIG.server.request_timeout_ms;
    return server;
}

export function startServer() {
    const server = createServer();

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

    return server;
}
