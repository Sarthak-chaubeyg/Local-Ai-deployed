/**
 * State Module — Centralized application state with safe persistence.
 * All mutable state lives here. Other modules read/write via AppState.
 *
 * Uses Security.SafeStorage for quota-aware, error-safe localStorage access.
 */
'use strict';

var AppState = {
    /* Chat data */
    chats: [],
    currentChatIndex: null,

    /* Model data */
    models: [],
    selectedModel: '',

    /* Generation state */
    isGenerating: false,
    currentAbortController: null,
    activePlaceholder: null,
    activePlaceholderChatIndex: null,
    generationToken: 0,

    /* Thinking mode */
    thinkingEnabled: false,
    thinkingSupported: false,

    /* Web Search */
    searchEnabled: false,

    /* Live streaming */
    activeLiveAssistant: null,

    /* Network */
    currentBaseUrl: '',
    isServerOnline: true,

    /* Model Manager */
    allDownloadedModels: [],
    mmBusy: new Set(),

    /* Copy registry — avoids inline content in HTML attributes */
    _copyRegistry: [],

    /* Toast timer */
    _toastTimer: null,

    /* Memory — persistent facts across chats */
    memories: []
};

/* ───────────────────────────────────────────────
 *  PERSISTENCE HELPERS (with SafeStorage)
 * ─────────────────────────────────────────────── */
function saveChats() {
    // Enforce max chats limit
    if (AppState.chats.length > AppConfig.MAX_CHATS) {
        AppState.chats = AppState.chats.slice(-AppConfig.MAX_CHATS);
        if (AppState.currentChatIndex !== null) {
            AppState.currentChatIndex = Math.min(AppState.currentChatIndex, AppState.chats.length - 1);
        }
    }
    // Enforce max messages per chat
    for (var i = 0; i < AppState.chats.length; i++) {
        var chat = AppState.chats[i];
        if (chat.messages && chat.messages.length > AppConfig.MAX_MESSAGES_PER_CHAT) {
            chat.messages = chat.messages.slice(-AppConfig.MAX_MESSAGES_PER_CHAT);
        }
    }
    Security.SafeStorage.set("all_chats", AppState.chats);
}

function saveModelSelection() {
    Security.SafeStorage.set("selected_model", AppState.selectedModel || "");
}

function saveBaseUrl() {
    Security.SafeStorage.set("lmstudio_base_url", Security.normalizeBaseUrl(AppState.currentBaseUrl));
}

function saveMemories() {
    Security.SafeStorage.set("user_memories", AppState.memories);
}

/* ───────────────────────────────────────────────
 *  LOAD STATE FROM STORAGE
 * ─────────────────────────────────────────────── */
function loadPersistedState() {
    // Load chats — with validation
    var rawChats = Security.SafeStorage.getJSON("all_chats", []);
    if (Array.isArray(rawChats)) {
        AppState.chats = rawChats.filter(function (chat) {
            return chat && typeof chat === 'object' && Array.isArray(chat.messages);
        }).map(function (chat) {
            // Sanitize each chat's title
            return {
                title: Security.validateChatTitle(chat.title || 'Untitled Chat'),
                messages: chat.messages.slice(0, AppConfig.MAX_MESSAGES_PER_CHAT).map(function (msg) {
                    if (!msg || typeof msg !== 'object') return null;
                    return {
                        role: String(msg.role || ''),
                        content: String(msg.content || ''),
                        thinking: String(msg.thinking || ''),
                        thinkingDuration: Number(msg.thinkingDuration || 0) || 0,
                        model: String(msg.model || ''),
                        usage: msg.usage || null,
                        finishReason: String(msg.finishReason || ''),
                        totalDuration: Number(msg.totalDuration || 0) || 0
                    };
                }).filter(Boolean)
            };
        });
    } else {
        AppState.chats = [];
    }

    // Load selected model
    AppState.selectedModel = Security.SafeStorage.get("selected_model", "");

    // Load base URL with validation
    // Smart default: use the web server's host (since LM Studio runs on the same machine)
    var _host = window.location.hostname;
    var _defaultBase = 'http://' +
        ((!_host || _host === 'localhost' || _host === '::1') ? '127.0.0.1' : _host) +
        ':' + AppConfig.SCAN_PORT;
    var savedUrl = Security.SafeStorage.get("lmstudio_base_url", _defaultBase);
    var normalizedUrl = Security.normalizeBaseUrl(savedUrl);
    if (Security.isSafeApiBase(normalizedUrl)) {
        AppState.currentBaseUrl = normalizedUrl;
    } else {
        AppState.currentBaseUrl = _defaultBase;
    }

    // Load memories
    var rawMemories = Security.SafeStorage.getJSON("user_memories", []);
    if (Array.isArray(rawMemories)) {
        AppState.memories = rawMemories.filter(function (m) {
            return m && typeof m === 'string' && m.trim();
        }).map(function (m) { return m.trim(); });
    } else {
        AppState.memories = [];
    }
}

/**
 * Build a context string from all stored memories to inject into the prompt.
 */
function buildMemoryContext() {
    if (!AppState.memories.length) return '';
    return '--- USER MEMORY (facts the user has asked you to remember across conversations) ---\n' +
        AppState.memories.map(function (m, i) { return (i + 1) + '. ' + m; }).join('\n') +
        '\n--- END USER MEMORY ---\n\nUse the above memories as context. Do not mention them unless directly relevant to the user\'s query.';
}

/**
 * Build a real-time context string with current date and time.
 */
function buildTimeContext() {
    var now = new Date();
    var days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    var months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

    var dayName = days[now.getDay()];
    var monthName = months[now.getMonth()];
    var date = now.getDate();
    var year = now.getFullYear();
    var time = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });

    return '--- REAL-TIME CONTEXT ---\n' +
        'Current Date: ' + dayName + ', ' + monthName + ' ' + date + ', ' + year + '\n' +
        'Current Time: ' + time + '\n' +
        '--- END REAL-TIME CONTEXT ---';
}
