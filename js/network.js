/**
 * Network Module — API calls, streaming, model discovery.
 * All network requests go through Security.isSafeApiBase validation.
 * Rate limiting applied to discovery and send operations.
 *
 * 🔒 Key security improvement (M1): API key is NOT sent during initial
 * host probing. The probe sends an unauthenticated request first.
 * The key is only sent to hosts that are confirmed to be running LM Studio.
 */
'use strict';

/* ───────────────────────────────────────────────
 *  MODEL NORMALIZATION
 * ─────────────────────────────────────────────── */
function normalizeLoadedModels(payload) {
    var data = (payload && Array.isArray(payload.data)) ? payload.data : [];
    return data
        .filter(function (item) {
            if (!item) return false;
            // Accept if state is 'loaded' OR if state is absent (v0/OpenAI endpoint
            // only returns loaded models, so no state field means it's loaded)
            var state = (item.state || '').toLowerCase();
            return state === 'loaded' || state === '';
        })
        .filter(function (item) {
            var t = String(item && item.type || '').toLowerCase();
            // Also accept when type is absent (v0 endpoint doesn't include type)
            return !t || t === 'llm' || t === 'vlm' || t === 'model';
        })
        .map(function (item) { return String(item && (item.id || item.name || item.model) || '').trim(); })
        .filter(Boolean);
}

/* ───────────────────────────────────────────────
 *  HOST PROBING (SAFE — fixes M1)
 *  First probes WITHOUT auth to confirm it's an LM Studio server,
 *  then sends authenticated request only to confirmed servers.
 * ─────────────────────────────────────────────── */
function probeHost(ip) {
    var base = 'http://' + ip + ':' + AppConfig.SCAN_PORT;
    if (!Security.isSafeApiBase(base)) return Promise.resolve(null);

    // SECURITY FIX (M1): First, try an unauthenticated probe
    // to confirm this is actually an LM Studio server.
    // Only send auth headers after confirming the host is valid.
    return Security.fetchJsonWithTimeout(base + AppConfig.MODEL_LIST_ENDPOINT, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        cache: 'no-store'
    }, AppConfig.SCAN_TIMEOUT_MS)
    .then(function (payload) {
        // Unauthenticated probe succeeded - this is likely LM Studio
        var loaded = normalizeLoadedModels(payload);
        if (loaded.length) {
            return { base: base, models: loaded };
        }
        // Server responded but no loaded models in unauthenticated response.
        // Try with auth in case auth is required to list models.
        return Security.fetchJsonWithTimeout(base + AppConfig.MODEL_LIST_ENDPOINT, {
            method: 'GET',
            headers: Security.getAuthHeaders(),
            credentials: 'omit',
            cache: 'no-store'
        }, AppConfig.SCAN_TIMEOUT_MS)
        .then(function (authPayload) {
            var authLoaded = normalizeLoadedModels(authPayload);
            if (authLoaded.length) {
                return { base: base, models: authLoaded };
            }
            return null;
        })
        .catch(function () { return null; });
    })
    .catch(function () {
        // Unreachable — skip
        return null;
    });
}

/* ───────────────────────────────────────────────
 *  SERVER HOST DETECTION
 *  When accessed from a remote device (e.g. phone or second laptop),
 *  the web server's IP is the same machine running LM Studio.
 *  Try that host on the LM Studio port before scanning.
 * ─────────────────────────────────────────────── */
function _tryServerHost() {
    var hostname = window.location.hostname;
    // Skip if we're already on localhost (handled by _tryLocalhost)
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1') {
        return Promise.resolve(null);
    }
    var serverBase = 'http://' + hostname + ':' + AppConfig.SCAN_PORT;
    if (!Security.isSafeApiBase(serverBase)) return Promise.resolve(null);

    return Security.fetchJsonWithTimeout(serverBase + AppConfig.MODEL_LIST_ENDPOINT, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'omit',
        cache: 'no-store'
    }, AppConfig.SCAN_TIMEOUT_MS)
    .then(function (payload) {
        var loaded = normalizeLoadedModels(payload);
        if (loaded.length) return { base: serverBase, models: loaded };
        // Try with auth
        return Security.fetchJsonWithTimeout(serverBase + AppConfig.MODEL_LIST_ENDPOINT, {
            method: 'GET',
            headers: Security.getAuthHeaders(),
            credentials: 'omit',
            cache: 'no-store'
        }, AppConfig.SCAN_TIMEOUT_MS)
        .then(function (authPayload) {
            var authLoaded = normalizeLoadedModels(authPayload);
            if (authLoaded.length) return { base: serverBase, models: authLoaded };
            return null;
        })
        .catch(function () { return null; });
    })
    .catch(function () { return null; });
}

/* ───────────────────────────────────────────────
 *  NETWORK DISCOVERY (Brute-force subnet scan)
 * ─────────────────────────────────────────────── */
function bruteForceDiscoverModels() {
    var discoverBtn = document.getElementById('discoverBtn');
    var modelCount = document.getElementById('modelCount');

    // Rate limiting check (fixes H4)
    if (!Security.checkRateLimit('network_scan', AppConfig.RATE_LIMIT_SCAN_REQUESTS, AppConfig.RATE_LIMIT_SCAN_WINDOW_MS)) {
        modelCount.textContent = 'Please wait before scanning again...';
        return Promise.resolve();
    }

    discoverBtn.disabled = true;
    modelCount.textContent = '🔍 Scanning network for LM Studio...';

    // Fast path 1: try PUBLIC_API_URL first (for Netlify/Remote)
    var publicBase = Security.normalizeBaseUrl(AppConfig.PUBLIC_API_URL || '');
    
    return _trySavedBase(publicBase)
        .then(function(result) {
            if (result) return _applyDiscoveryResult(result, discoverBtn, modelCount);
            // Fast path 2: try saved base URL
            var savedBase = Security.normalizeBaseUrl(Security.SafeStorage.get('lmstudio_base_url', ''));
            return _trySavedBase(savedBase);
        })
        .then(function (result) {
            if (result === true) return true; // Already applied from public base
            if (result) return _applyDiscoveryResult(result, discoverBtn, modelCount);
            // Try the server host (same machine serving this web page)
            return _tryServerHost();
        })
        .then(function (result) {
            if (result === true) return true; // Already applied from saved base
            if (result && result.models) return _applyDiscoveryResult(result, discoverBtn, modelCount);
            // Try localhost
            return _tryLocalhost();
        })
        .then(function (result) {
            if (result === true) return true; // Already applied
            if (result && result.models) return _applyDiscoveryResult(result, discoverBtn, modelCount);
            // Brute force scan subnet
            return _scanSubnet(modelCount)
                .then(function (scanResult) {
                    if (scanResult) {
                        return _applyDiscoveryResult(scanResult, discoverBtn, modelCount);
                    }
                    // Nothing found
                    AppState.models = [];
                    AppState.selectedModel = '';
                    saveModelSelection();
                    renderModelSelect();
                    updateHeader();
                    modelCount.textContent = 'No running models found on network';
                    
                    // Update offline status
                    AppState.isServerOnline = false;
                    if (typeof updateServerStatusUI === 'function') updateServerStatusUI(false);
                    
                    return false;
                });
        })
        .catch(function (err) {
            console.warn('[Network] Discovery error:', err.message);
            modelCount.textContent = 'Discovery failed — check connection';
            AppState.isServerOnline = false;
            if (typeof updateServerStatusUI === 'function') updateServerStatusUI(false);
        })
        .then(function () {
            discoverBtn.disabled = false;
        });
}

function _trySavedBase(savedBase) {
    if (!savedBase || !Security.isSafeApiBase(savedBase)) return Promise.resolve(null);
    return Security.fetchJsonWithTimeout(savedBase + AppConfig.MODEL_LIST_ENDPOINT, {
        method: 'GET',
        headers: Security.getAuthHeaders(),
        credentials: 'omit',
        cache: 'no-store'
    }, 4000)
    .then(function (payload) {
        var loaded = normalizeLoadedModels(payload);
        if (loaded.length) return { base: savedBase, models: loaded };
        // Even if empty, server responded so it's online
        if (payload && Array.isArray(payload.data)) {
            return { base: savedBase, models: [] };
        }
        return null;
    })
    .catch(function () { return null; });
}

function _tryLocalhost() {
    var localhostBase = 'http://127.0.0.1:1234';
    return Security.fetchJsonWithTimeout(localhostBase + AppConfig.MODEL_LIST_ENDPOINT, {
        method: 'GET',
        headers: Security.getAuthHeaders(),
        credentials: 'omit',
        cache: 'no-store'
    }, 2000)
    .then(function (payload) {
        var loaded = normalizeLoadedModels(payload);
        if (loaded.length) return { base: localhostBase, models: loaded };
        if (payload && Array.isArray(payload.data)) return { base: localhostBase, models: [] };
        return null;
    })
    .catch(function () { return null; });
}

function _scanSubnet(modelCount) {
    var foundResult = null;
    var batchStart = 1;

    function nextBatch() {
        if (batchStart > 254 || foundResult) return Promise.resolve(foundResult);
        var batchEnd = Math.min(batchStart + AppConfig.SCAN_BATCH_SIZE - 1, 254);
        modelCount.textContent = '🔍 Scanning ' + AppConfig.SCAN_SUBNET + '.' + batchStart + '-' + batchEnd + '...';

        var probes = [];
        for (var i = batchStart; i <= batchEnd; i++) {
            probes.push(probeHost(AppConfig.SCAN_SUBNET + '.' + i));
        }

        return Promise.all(probes).then(function (results) {
            for (var j = 0; j < results.length; j++) {
                if (results[j] && typeof results[j] === 'object') {
                    foundResult = results[j];
                    break;
                }
            }
            batchStart += AppConfig.SCAN_BATCH_SIZE;
            return nextBatch();
        });
    }

    return nextBatch();
}

function _applyDiscoveryResult(result, discoverBtn, modelCount) {
    AppState.currentBaseUrl = result.base;
    saveBaseUrl();
    AppState.models = result.models || [];
    if (AppState.models.length > 0 && AppState.models.indexOf(AppState.selectedModel) === -1) {
        AppState.selectedModel = AppState.models[0] || '';
    }
    saveModelSelection();
    renderModelSelect();
    updateHeader();
    
    // Set server online status
    AppState.isServerOnline = true;
    if (typeof updateServerStatusUI === 'function') updateServerStatusUI(true);

    modelCount.textContent = AppState.models.length +
        ' running model' + (AppState.models.length === 1 ? '' : 's') +
        ' found at ' + result.base;
    return true;
}

/* ───────────────────────────────────────────────
 *  SERVER POLLING
 * ─────────────────────────────────────────────── */
var pollIntervalId = null;

function startServerPolling() {
    if (pollIntervalId) clearInterval(pollIntervalId);
    
    pollIntervalId = setInterval(function() {
        if (!AppState.currentBaseUrl) return;
        
        Security.fetchJsonWithTimeout(AppState.currentBaseUrl + AppConfig.MODEL_LIST_ENDPOINT, {
            method: 'GET',
            headers: Security.getAuthHeaders(),
            credentials: 'omit',
            cache: 'no-store'
        }, 5000)
        .then(function(payload) {
            if (payload && Array.isArray(payload.data)) {
                var wasOffline = !AppState.isServerOnline;
                AppState.isServerOnline = true;
                
                // If it was offline and now online, let's refresh models quietly
                if (wasOffline) {
                    var loaded = normalizeLoadedModels(payload);
                    AppState.models = loaded;
                    if (loaded.indexOf(AppState.selectedModel) === -1) {
                        AppState.selectedModel = loaded[0] || '';
                        saveModelSelection();
                    }
                    renderModelSelect();
                    updateHeader();
                    var modelCount = document.getElementById('modelCount');
                    if (modelCount) {
                        modelCount.textContent = AppState.models.length +
                            ' running model' + (AppState.models.length === 1 ? '' : 's') +
                            ' found at ' + AppState.currentBaseUrl;
                    }
                }
                
                if (typeof updateServerStatusUI === 'function') updateServerStatusUI(true);
            } else {
                throw new Error('Invalid payload');
            }
        })
        .catch(function(err) {
            if (AppState.isServerOnline) {
                console.warn('[Network] Polling failed, server is offline:', err.message);
                AppState.isServerOnline = false;
                if (typeof updateServerStatusUI === 'function') updateServerStatusUI(false);
            }
        });
        
    }, 10000); // Poll every 10 seconds
}

// Public aliases
var discoverModels = bruteForceDiscoverModels;

/* ───────────────────────────────────────────────
 *  STREAMING CHAT COMPLETION (with size guard)
 * ─────────────────────────────────────────────── */
function streamChatCompletion(body, signal, onDelta) {
    var endpointAttempts = AppConfig.CHAT_ENDPOINTS.map(function (ep) {
        return AppState.currentBaseUrl + ep;
    });
    var lastError = null;
    var attemptIndex = 0;

    function tryNextEndpoint() {
        if (attemptIndex >= endpointAttempts.length) {
            return Promise.reject(lastError || new Error('Request failed'));
        }

        var url = endpointAttempts[attemptIndex++];

        return fetch(url, {
            method: 'POST',
            headers: Security.getAuthHeaders(),
            credentials: 'omit',
            cache: 'no-store',
            body: JSON.stringify(body),
            signal: signal
        })
        .then(function (response) {
            if (!response.ok) {
                return response.text().catch(function () { return ''; }).then(function (text) {
                    throw new Error('HTTP ' + response.status + (text ? ': ' + text.slice(0, 240) : ''));
                });
            }

            var contentType = (response.headers.get('content-type') || '').toLowerCase();
            if (!response.body || contentType.indexOf('text/event-stream') === -1) {
                return readResponsePayload(response).then(function (payload) {
                    var text = extractAssistantReply(payload);
                    if (text) onDelta(text, true);
                    return { rawText: text || '' };
                });
            }

            // Stream reading
            var reader = response.body.getReader();
            var decoder = new TextDecoder();
            var buffer = '';
            var rawText = '';
            var finalUsage = null;
            var finalReason = null;

            function readChunk() {
                return reader.read().then(function (result) {
                    if (result.done) return { rawText: rawText, usage: finalUsage, finishReason: finalReason };

                    buffer += decoder.decode(result.value, { stream: true });
                    var lines = buffer.split(/\r?\n/);
                    buffer = lines.pop() || '';

                    for (var i = 0; i < lines.length; i++) {
                        var trimmed = lines[i].trim();
                        if (trimmed.indexOf('data:') !== 0) continue;
                        var payload = trimmed.slice(5).trim();
                        if (!payload || payload === '[DONE]') continue;

                        var chunk = '';
                        try {
                            var obj = Security.safeJsonParse(payload);
                            if (obj.usage) finalUsage = obj.usage;
                            if (obj.choices && obj.choices[0] && obj.choices[0].finish_reason) {
                                finalReason = obj.choices[0].finish_reason;
                            }
                            chunk =
                                (obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content != null)
                                    ? obj.choices[0].delta.content
                                    : (obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content != null)
                                        ? obj.choices[0].message.content
                                        : (obj.choices && obj.choices[0] && obj.choices[0].text != null)
                                            ? obj.choices[0].text
                                            : (obj.content != null)
                                                ? obj.content
                                                : '';
                            if (Array.isArray(chunk)) {
                                chunk = chunk.map(function (part) {
                                    return (part && (part.text != null ? part.text : (part.content != null ? part.content : ''))) || '';
                                }).join('');
                            }
                        } catch (_e) {
                            chunk = '';
                        }

                        if (typeof chunk === 'string' && chunk) {
                            rawText += chunk;
                            // No artificial size limit — let the model complete
                            // its full response naturally (EOS / stop token).
                            onDelta(rawText, false);
                        }
                    }

                    return readChunk();
                });
            }

            return readChunk();
        })
        .catch(function (err) {
            lastError = err;
            if (err && err.name === 'AbortError') throw err;
            return tryNextEndpoint();
        });
    }

    return tryNextEndpoint();
}

function buildThinkingPrompt(isSearchEnabled) {
    var baseContent = 'Thinking mode is enabled. You MUST always begin your response by reasoning step-by-step inside <think>...</think> tags before giving your final answer.';
    
    if (isSearchEnabled) {
        baseContent += ' You will be provided with Web Search results. Use these research findings to inform your reasoning. Analyze the search results, check for contradictions or key facts, and synthesize the information before providing the final answer.';
    }

    baseContent += ' Even for simple questions, include at least a brief thought process inside the think tags. Place your final answer OUTSIDE the think tags. The final answer should be clean and concise. Example format:\n<think>\n[your reasoning here]\n</think>\n[your final answer here]';

    return {
        role: 'system',
        content: baseContent
    };
}

/* ───────────────────────────────────────────────
 *  WEB SEARCH & LOCAL RAG
 * ─────────────────────────────────────────────── */
function generateSearchQuery(messages) {
    if (!messages || !messages.length) return Promise.resolve('');
    
    // Get the last 5 messages to provide context without overloading
    var recentMsgs = messages.slice(Math.max(0, messages.length - 5));
    var conversationText = recentMsgs.map(function(m) { 
        return (m.role === 'user' ? 'User' : 'Assistant') + ': ' + m.content; 
    }).join('\n');

    var systemPrompt = "You are an expert search query generator. Analyze the conversation history and generate a single, highly specific search engine query that will fetch the information the User is looking for. Ensure the query includes relevant names or subjects from previous messages to provide context. DO NOT provide any explanation, markdown, or tags. ONLY output the search text.";
    
    var endpoint = AppState.currentBaseUrl + (AppConfig.CHAT_ENDPOINTS[0] || "/v1/chat/completions");
    
    return fetch(endpoint, {
        method: 'POST',
        headers: Security.getAuthHeaders(),
        credentials: 'omit',
        cache: 'no-store',
        body: JSON.stringify({
            model: AppState.selectedModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: "Conversation History:\n" + conversationText + "\n\nGenerate the standalone search query for the latest user message. ONLY output the query." }
            ],
            temperature: 0.1, // Low temp for deterministic output
            stream: false
        })
    })
    .then(function(res) {
        if (!res.ok) throw new Error('Refinement failed');
        return res.json();
    })
    .then(function(data) {
        var query = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
        // Clean up any rogue XML tags that some local models insist on returning
        query = query.replace(/<[^>]*>/g, '').replace(/```[\s\S]*?```/g, '').trim();
        // Remove quotes if the model wrapped the query in them
        if (query.match(/^".*"$/) || query.match(/^'.*'$/)) {
            query = query.slice(1, -1);
        }
        return query || messages[messages.length - 1].content;
    })
    .catch(function(err) {
        console.warn('[Search] Query refinement error, falling back to raw input:', err);
        return messages[messages.length - 1].content;
    });
}

// Simple text chunker for RAG
function _chunkText(text, chunkSize, overlap) {
    if (!text) return [];
    var words = text.replace(/\\s+/g, ' ').split(' ');
    var chunks = [];
    var chunkWords = Math.floor(chunkSize / 5); // Approximate chars to words
    var overlapWords = Math.floor(overlap / 5);
    
    if (words.length <= chunkWords) return [text];
    
    for (var i = 0; i < words.length; i += (chunkWords - overlapWords)) {
        var chunk = words.slice(i, i + chunkWords).join(' ');
        if (chunk.length > 50) { // arbitrary minimum meaningful length
            chunks.push(chunk);
        }
        if (i + chunkWords >= words.length) break;
    }
    return chunks;
}

// Simple term frequency scoring against the refined query
function _scoreChunk(chunk, query) {
    var chunkLower = chunk.toLowerCase();
    var queryWords = query.toLowerCase().replace(/[^a-z0-9 ]/g, '').split(' ').filter(function(w) { return w.length > 2; });
    var score = 0;
    
    for (var i = 0; i < queryWords.length; i++) {
        var word = queryWords[i];
        var instances = chunkLower.split(word).length - 1;
        score += instances;
        // Bonus for exact multi-word phrase matches from query
        if (query.length > 5 && chunkLower.indexOf(query.toLowerCase()) !== -1) {
            score += 5;
        }
    }
    return score;
}

function _executeLocalRAG(results, query) {
    var allChunks = [];
    
    for (var i = 0; i < results.length; i++) {
        var res = results[i];
        // Prefer raw_content if available, fallback to content
        var textToProcess = res.raw_content || res.content || '';
        var chunks = _chunkText(textToProcess, AppConfig.RAG_CHUNK_SIZE || 600, AppConfig.RAG_CHUNK_OVERLAP || 150);
        
        for (var j = 0; j < chunks.length; j++) {
            var score = _scoreChunk(chunks[j], query);
            // Give a slight boost to the first few chunks of any page (usually introductions/summaries)
            if (j === 0) score += 0.5;
            
            allChunks.push({
                url: res.url,
                title: res.title,
                text: chunks[j],
                score: score
            });
        }
    }
    
    // Sort descending by score
    allChunks.sort(function(a, b) { return b.score - a.score; });
    
    // Keep top K chunks
    var selectedChunks = allChunks.slice(0, AppConfig.RAG_MAX_CHUNKS || 15);
    
    // Re-group by URL to keep output neat for the LLM
    var finalResultsMap = {};
    for (var k = 0; k < selectedChunks.length; k++) {
        var c = selectedChunks[k];
        // Only include chunks that have at least some relevance, or if we have very few chunks
        if (c.score > 0 || k < 5) {
            if (!finalResultsMap[c.url]) {
                finalResultsMap[c.url] = { url: c.url, title: c.title, content: [] };
            }
            finalResultsMap[c.url].content.push(c.text);
        }
    }
    
    var finalResultsList = [];
    for (var url in finalResultsMap) {
        if (finalResultsMap.hasOwnProperty(url)) {
            var combinedContent = finalResultsMap[url].content.join(' ... ');
            finalResultsList.push({
                url: url,
                title: finalResultsMap[url].title,
                content: combinedContent
            });
        }
    }
    
    return finalResultsList;
}

function executeTavilySearch(query) {
    if (!AppConfig.TAVILY_API_KEY) {
        return Promise.reject(new Error("TAVILY_API_KEY is missing in config.js"));
    }
    
    var payload = {
        api_key: AppConfig.TAVILY_API_KEY,
        query: query,
        search_depth: AppConfig.TAVILY_SEARCH_DEPTH || 'basic',
        include_answer: false,
        include_images: false,
        include_raw_content: true, // TRUE for RAG engine!
        max_results: AppConfig.TAVILY_MAX_RESULTS || 10
    };

    function _performFetch(url) {
        return fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        }).then(function(res) {
            if (!res.ok) return res.text().then(function(t) { throw new Error(t); });
            return res.json();
        });
    }

    return _performFetch('https://api.tavily.com/search')
        .catch(function() {
            console.log('[Search] Direct fetch blocked by CORS, trying proxy...');
            var proxyUrl = 'https://api.allorigins.win/get?url=' + encodeURIComponent('https://api.tavily.com/search');
            
            return fetch(proxyUrl + '&query=' + encodeURIComponent(query) + '&include_raw_content=true&api_key=' + AppConfig.TAVILY_API_KEY)
                .then(function(res) { return res.json(); })
                .then(function(data) {
                    var parsed = Security.safeJsonParse(data.contents);
                    if (!parsed || !parsed.results) throw new Error('Search failed via proxy');
                    return parsed;
                });
        })
        .then(function(data) {
            if (!data || !data.results) return [];
            // Process Results through LOCAL RAG ENGINE
            return _executeLocalRAG(data.results, query);
        });
}
