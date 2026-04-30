/**
 * Security Module — Core security utilities and hardening.
 * Provides CSP injection, sanitization, validation, rate limiting,
 * safe JSON parsing, safe localStorage, and network validators.
 *
 * 🔒 All public methods are exposed via the frozen `Security` object.
 */
'use strict';

var Security = (function () {

    /* ───────────────────────────────────────────────
     *  CSP INJECTION
     * ─────────────────────────────────────────────── */
    function injectCSP() {
        // Only inject if not already present
        if (document.querySelector('meta[http-equiv="Content-Security-Policy"]')) return;
        var meta = document.createElement('meta');
        meta.httpEquiv = 'Content-Security-Policy';
        meta.content = [
            "default-src 'self'",
            "script-src 'self'",
            "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com https://cdn.jsdelivr.net",
            "font-src https://fonts.gstatic.com https://cdn.jsdelivr.net",
            "connect-src *",           // Required for local network scanning of arbitrary IPs
            "img-src 'self' data:",
            "object-src 'none'",
            "base-uri 'self'",
            "frame-src 'none'",
            "form-action 'self'"
        ].join('; ');
        document.head.prepend(meta);
    }

    /* ───────────────────────────────────────────────
     *  HTML ESCAPING (Complete — fixes C4, H2)
     * ─────────────────────────────────────────────── */
    function escapeHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    /**
     * Attribute escaping — FIXED from original which only escaped single quotes.
     * Now escapes all characters that are dangerous in HTML attribute context.
     */
    function escapeAttr(value) {
        return String(value || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/`/g, '&#x60;');
    }

    /* ───────────────────────────────────────────────
     *  INPUT SANITIZATION (fixes C5)
     * ─────────────────────────────────────────────── */
    function sanitizeInput(text, maxLength) {
        var limit = maxLength || AppConfig.MAX_INPUT_LENGTH;
        var sanitized = String(text || '');
        // Remove null bytes
        sanitized = sanitized.replace(/\0/g, '');
        // Normalize unicode
        if (typeof sanitized.normalize === 'function') {
            sanitized = sanitized.normalize('NFC');
        }
        // Remove invisible control characters (keep newlines \n, carriage returns \r, tabs \t)
        sanitized = sanitized.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
        // Enforce length limit
        if (sanitized.length > limit) {
            sanitized = sanitized.slice(0, limit);
        }
        return sanitized;
    }

    function validateChatTitle(title) {
        var safe = sanitizeInput(title, AppConfig.MAX_CHAT_TITLE_LENGTH);
        // Strip any HTML tags
        safe = safe.replace(/<[^>]*>/g, '');
        return safe.trim() || 'Untitled Chat';
    }

    /* ───────────────────────────────────────────────
     *  RATE LIMITER — Token Bucket (fixes H4)
     * ─────────────────────────────────────────────── */
    var _rateBuckets = {};

    /**
     * Check if an action is allowed under rate limiting.
     * @param {string} key - Unique identifier for the action type
     * @param {number} maxTokens - Max requests per window
     * @param {number} windowMs - Window duration in ms
     * @returns {boolean} true if allowed, false if rate-limited
     */
    function checkRateLimit(key, maxTokens, windowMs) {
        var now = Date.now();
        var bucket = _rateBuckets[key] || { tokens: maxTokens, lastRefill: now };

        // Refill tokens based on elapsed time
        var elapsed = now - bucket.lastRefill;
        var refillRate = maxTokens / windowMs;
        bucket.tokens = Math.min(maxTokens, bucket.tokens + elapsed * refillRate);
        bucket.lastRefill = now;

        if (bucket.tokens < 1) {
            _rateBuckets[key] = bucket;
            return false;
        }

        bucket.tokens -= 1;
        _rateBuckets[key] = bucket;
        return true;
    }

    /* ───────────────────────────────────────────────
     *  SAFE JSON PARSING (fixes H5 — prototype pollution)
     * ─────────────────────────────────────────────── */
    function sanitizeJsonValue(obj) {
        if (obj === null || typeof obj !== 'object') return obj;
        if (Array.isArray(obj)) return obj.map(sanitizeJsonValue);

        var clean = {};
        var keys = Object.keys(obj);
        for (var i = 0; i < keys.length; i++) {
            var key = keys[i];
            // Block prototype pollution vectors
            if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
            clean[key] = sanitizeJsonValue(obj[key]);
        }
        return clean;
    }

    function safeJsonParse(text) {
        if (!text) return {};
        var parsed = JSON.parse(text);
        return sanitizeJsonValue(parsed);
    }

    /* ───────────────────────────────────────────────
     *  NETWORK VALIDATORS
     * ─────────────────────────────────────────────── */
    function normalizeBaseUrl(value) {
        return String(value || '').trim().replace(/\/+$/, '');
    }

    function isPrivateIpHost(hostname) {
        if (!hostname) return false;
        if (/^(10\.|192\.168\.|127\.|169\.254\.)/.test(hostname)) return true;
        var m = hostname.match(/^172\.(\d+)\./);
        if (m) {
            var second = Number(m[1]);
            return second >= 16 && second <= 31;
        }
        return false;
    }

    function isSafeApiBase(baseUrl) {
        try {
            var url = new URL(normalizeBaseUrl(baseUrl));
            if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
            if (AppConfig.ALLOWED_LOCALHOSTS.indexOf(url.hostname) !== -1) return true;
            if (AppConfig.ALLOW_PRIVATE_NETWORK && isPrivateIpHost(url.hostname)) return true;
            // Allow the explicitly configured PUBLIC_API_URL (tunnel)
            var publicUrl = normalizeBaseUrl(AppConfig.PUBLIC_API_URL || '');
            if (publicUrl && normalizeBaseUrl(baseUrl) === publicUrl) return true;
            // Allow any HTTPS URL (tunnels like loca.lt, ngrok.io always use HTTPS)
            if (url.protocol === 'https:') return true;
            return false;
        } catch (_e) {
            return false;
        }
    }

    function getAuthHeaders() {
        var headers = { "Content-Type": "application/json" };
        var apiKey = String(AppConfig.LMSTUDIO_API_KEY || "").trim();
        if (AppConfig.REQUIRE_API_KEY && !apiKey) {
            throw new Error("API key missing — configure it in js/config.js");
        }
        if (apiKey) {
            headers.Authorization = "Bearer " + apiKey;
        }
        return headers;
    }

    /* ───────────────────────────────────────────────
     *  SAFE LOCALSTORAGE WRAPPER (fixes H3)
     * ─────────────────────────────────────────────── */
    var SafeStorage = {
        _estimateUsageBytes: function () {
            var total = 0;
            try {
                for (var i = 0; i < localStorage.length; i++) {
                    var key = localStorage.key(i);
                    total += (key || '').length + (localStorage.getItem(key) || '').length;
                }
            } catch (_e) { /* storage inaccessible */ }
            return total * 2; // UTF-16 = 2 bytes per char
        },

        get: function (key, defaultValue) {
            try {
                var raw = localStorage.getItem(key);
                return raw !== null ? raw : (defaultValue !== undefined ? defaultValue : null);
            } catch (e) {
                console.warn('[SafeStorage] get failed:', e.message);
                return defaultValue !== undefined ? defaultValue : null;
            }
        },

        getJSON: function (key, defaultValue) {
            try {
                var raw = localStorage.getItem(key);
                if (raw === null) return defaultValue !== undefined ? defaultValue : null;
                return safeJsonParse(raw);
            } catch (e) {
                console.warn('[SafeStorage] getJSON failed:', e.message);
                return defaultValue !== undefined ? defaultValue : null;
            }
        },

        set: function (key, value) {
            try {
                var serialized = (typeof value === 'string') ? value : JSON.stringify(value);
                var newSize = (key.length + serialized.length) * 2;
                var currentUsage = this._estimateUsageBytes();
                var limitBytes = AppConfig.MAX_LOCALSTORAGE_MB * 1024 * 1024;

                // Check if old value exists (we'll replace it, so subtract its size)
                var existing = localStorage.getItem(key);
                if (existing !== null) {
                    currentUsage -= (key.length + existing.length) * 2;
                }

                if (currentUsage + newSize > limitBytes) {
                    console.warn('[SafeStorage] quota would be exceeded, refusing write for key:', key);
                    return false;
                }

                localStorage.setItem(key, serialized);
                return true;
            } catch (e) {
                console.warn('[SafeStorage] set failed:', e.message);
                return false;
            }
        },

        remove: function (key) {
            try {
                localStorage.removeItem(key);
            } catch (e) {
                console.warn('[SafeStorage] remove failed:', e.message);
            }
        }
    };

    /* ───────────────────────────────────────────────
     *  RESPONSE SIZE GUARD (fixes H7)
     * ─────────────────────────────────────────────── */
    function enforceResponseSizeLimit(text) {
        if (typeof text !== 'string') return String(text || '');
        if (text.length > AppConfig.MAX_STREAMING_SIZE) {
            return text.slice(0, AppConfig.MAX_STREAMING_SIZE) +
                '\n\n[Response truncated — exceeded ' +
                (AppConfig.MAX_STREAMING_SIZE / 1024 / 1024).toFixed(1) + ' MB limit]';
        }
        return text;
    }

    /* ───────────────────────────────────────────────
     *  SAFE FETCH WITH TIMEOUT
     * ─────────────────────────────────────────────── */
    function fetchJsonWithTimeout(url, options, timeoutMs) {
        var timeout = timeoutMs || 120000;
        var controller = new AbortController();
        var timer = setTimeout(function () { controller.abort(); }, timeout);

        var fetchOptions = {};
        for (var k in options) {
            if (options.hasOwnProperty(k)) fetchOptions[k] = options[k];
        }
        fetchOptions.signal = controller.signal;

        return fetch(url, fetchOptions)
            .then(function (res) {
                clearTimeout(timer);
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.text();
            })
            .then(function (text) {
                if (!text) return {};
                try {
                    return safeJsonParse(text);
                } catch (_e) {
                    return { raw: text };
                }
            })
            .catch(function (err) {
                clearTimeout(timer);
                throw err;
            });
    }

    /* ───────────────────────────────────────────────
     *  INITIALIZE — inject CSP on load
     * ─────────────────────────────────────────────── */
    injectCSP();

    /* ───────────────────────────────────────────────
     *  PUBLIC API (frozen — cannot be tampered with)
     * ─────────────────────────────────────────────── */
    return Object.freeze({
        escapeHtml: escapeHtml,
        escapeAttr: escapeAttr,
        sanitizeInput: sanitizeInput,
        validateChatTitle: validateChatTitle,
        checkRateLimit: checkRateLimit,
        safeJsonParse: safeJsonParse,
        sanitizeJsonValue: sanitizeJsonValue,
        normalizeBaseUrl: normalizeBaseUrl,
        isPrivateIpHost: isPrivateIpHost,
        isSafeApiBase: isSafeApiBase,
        getAuthHeaders: getAuthHeaders,
        SafeStorage: SafeStorage,
        enforceResponseSizeLimit: enforceResponseSizeLimit,
        fetchJsonWithTimeout: fetchJsonWithTimeout
    });
})();
