/* ╔═══════════════════════════════════════════════════════════╗
 * ║          CONFIGURATION TEMPLATE                          ║
 * ╠═══════════════════════════════════════════════════════════╣
 * ║                                                           ║
 * ║  📋 SETUP INSTRUCTIONS:                                   ║
 * ║  1. Copy this file and rename it to  config.js            ║
 * ║  2. Fill in your real API keys below.                     ║
 * ║  3. config.js is .gitignored — it will NEVER be pushed.   ║
 * ║                                                           ║
 * ║  🔒 SECURITY:                                             ║
 * ║  config.js is excluded from version control.              ║
 * ║  This template (config.example.js) contains NO secrets.   ║
 * ║                                                           ║
 * ╚═══════════════════════════════════════════════════════════╝ */
'use strict';

var AppConfig = Object.freeze({
    /* ⬇️⬇️⬇️ CHANGE THIS — paste your LM Studio API key here ⬇️⬇️⬇️ */
    LMSTUDIO_API_KEY: "",

    /* ⬇️⬇️⬇️ CHANGE THIS — paste your Free Tavily API key here ⬇️⬇️⬇️ */
    TAVILY_API_KEY: "",
    TAVILY_SEARCH_DEPTH: "basic",
    TAVILY_MAX_RESULTS: 10,

    /* ⬇️⬇️⬇️ REMOTE ACCESS (Netlify) ⬇️⬇️⬇️ */
    /* If hosting on Netlify, you MUST use a tunneling service (like Ngrok, Pinggy, LocalTunnel)
       to expose your local LM Studio. Paste the HTTPS URL here. 
       Leave empty ("") for local offline use. */
    PUBLIC_API_URL: "https://minneapolis-involves-pension-daily.trycloudflare.com",

    /* API Endpoints */
    CHAT_ENDPOINTS: Object.freeze(["/v1/chat/completions", "/api/v0/chat/completions"]),
    MODEL_LIST_ENDPOINT: "/api/v0/models",
    MODEL_LIST_V1_ENDPOINT: "/api/v1/models",
    MODEL_LOAD_ENDPOINT: "/api/v1/models/load",
    MODEL_UNLOAD_ENDPOINT: "/api/v1/models/unload",

    /* Auth & Network */
    REQUIRE_API_KEY: false,
    ALLOWED_LOCALHOSTS: Object.freeze(["localhost", "127.0.0.1", "::1"]),
    ALLOW_PRIVATE_NETWORK: true,

    /* Limits & Guards */
    MAX_RESPONSE_CHARS: 120000,
    MAX_CONTEXT_MESSAGES: 24,
    MAX_INPUT_LENGTH: 32000,
    MAX_CHAT_TITLE_LENGTH: 100,
    MAX_CHATS: 500,
    MAX_MESSAGES_PER_CHAT: 2000,
    MAX_STREAMING_SIZE: 5 * 1024 * 1024,
    MAX_LOCALSTORAGE_MB: 4.5,
    MAX_UPLOAD_SIZE_MB: 30,

    /* RAG & Search Constraints */
    RAG_CHUNK_SIZE: 1000,
    RAG_CHUNK_OVERLAP: 200,
    RAG_MAX_CHUNKS: 30,

    /* Network Scanning */
    SCAN_SUBNET: "192.168.1",
    SCAN_PORT: 1234,
    SCAN_TIMEOUT_MS: 600,
    SCAN_BATCH_SIZE: 60,

    /* Rate Limiting (token-bucket) */
    RATE_LIMIT_SEND_REQUESTS: 5,
    RATE_LIMIT_SEND_WINDOW_MS: 10000,
    RATE_LIMIT_SCAN_REQUESTS: 2,
    RATE_LIMIT_SCAN_WINDOW_MS: 30000
});
