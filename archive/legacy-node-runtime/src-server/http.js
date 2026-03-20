import fs from 'fs';
import path from 'path';

import { DEFAULT_CONFIG, clampNumber, getRuntimeConfig } from './config.js';

export function parseBody(req, maxBytes = 1_000_000) {
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

export function validateTestResults(payload, config) {
    if (!payload || typeof payload !== 'object') {
        return { ok: false, error: 'Invalid JSON payload' };
    }

    if (!payload.sentinel_results || typeof payload.sentinel_results !== 'object' || Array.isArray(payload.sentinel_results)) {
        return { ok: false, error: 'sentinel_results must be an object' };
    }

    const maxSentinelResults = config?.limits?.max_sentinel_results || DEFAULT_CONFIG.limits.max_sentinel_results;
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

export function applyCorsHeaders(res, req, config, { preflight = false } = {}) {
    if (!config?.cors || config.cors.enabled !== true) return;

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

export function applySecurityHeaders(res, config) {
    if (!config?.security_headers || config.security_headers.enabled !== true) return;

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

export function sendJSON(res, status, data, config, req) {
    const cfg = config || getRuntimeConfig();
    if (req) applyCorsHeaders(res, req, cfg);
    applySecurityHeaders(res, cfg);
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data, null, 2));
}

export function sendText(res, status, text, config, req) {
    const cfg = config || getRuntimeConfig();
    if (req) applyCorsHeaders(res, req, cfg);
    applySecurityHeaders(res, cfg);
    res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(String(text || ''));
}

export function sendEmpty(res, status, config, req) {
    const cfg = config || getRuntimeConfig();
    if (req) applyCorsHeaders(res, req, cfg);
    applySecurityHeaders(res, cfg);
    res.writeHead(status);
    res.end();
}

export function sendDisabled(res, config, req) {
    const cfg = config || getRuntimeConfig();
    const response = cfg.service?.disabled_response || DEFAULT_CONFIG.service.disabled_response;
    const status = clampNumber(response.status, DEFAULT_CONFIG.service.disabled_response.status, { min: 100, max: 599 });

    if (response.mode === 'json') return sendJSON(res, status, response.json || { success: false, error: 'disabled' }, cfg, req);
    if (response.mode === 'text') return sendText(res, status, response.text || 'disabled', cfg, req);
    return sendEmpty(res, status, cfg, req);
}

export function inferContentType(filePath) {
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.html') return 'text/html; charset=utf-8';
    if (ext === '.css') return 'text/css; charset=utf-8';
    if (ext === '.js') return 'application/javascript; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.svg') return 'image/svg+xml';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.webp') return 'image/webp';
    return 'application/octet-stream';
}

export function serveStatic(res, filePath, config, req) {
    try {
        const contentType = inferContentType(filePath);
        const encoding = contentType.startsWith('text/') || contentType.includes('javascript') || contentType.includes('json')
            ? 'utf8'
            : null;
        const content = fs.readFileSync(filePath, encoding);
        const cfg = config || getRuntimeConfig();
        if (req) applyCorsHeaders(res, req, cfg);
        applySecurityHeaders(res, cfg);
        res.writeHead(200, { 'Content-Type': contentType });
        if (req?.method === 'HEAD') {
            res.end();
            return;
        }
        res.end(content);
    } catch {
        sendText(res, 404, 'Not found', config, req);
    }
}
