/**
 * App Module — Initialization, wire-up, and main send message flow.
 * This is the entry point that ties all modules together.
 *
 * 🔒 Security features in this module:
 * - Rate limiting on message send (fixes H4)
 * - Input sanitization before processing (fixes C5)
 * - Safe URL validation before API calls
 * - Error boundaries on init (fixes L2)
 * - No console assertions in production (fixes L3)
 */
'use strict';

/* ───────────────────────────────────────────────
 *  GENERATION CONTROL
 * ─────────────────────────────────────────────── */
function stopGeneration() {
    if (!AppState.isGenerating) return;
    if (AppState.currentAbortController) AppState.currentAbortController.abort();
    AppState.isGenerating = false;
    morphSendBtn('send');
    setStoppedPlaceholder();
    if (AppState.currentChatIndex !== null) {
        AppState.chats[AppState.currentChatIndex].messages.push({ role: 'system', content: 'model was stopped' });
        saveChats();
    }
    setStatus('Model was stopped');
    var pill = document.getElementById('headerPill');
    if (pill) pill.textContent = '⏹ Stopped';
}

/* ───────────────────────────────────────────────
 *  SEND MESSAGE (with rate limiting & input validation)
 * ─────────────────────────────────────────────── */
function sendMessage() {
    var input = document.getElementById('input');
    var sendBtn = document.getElementById('sendBtn');
    var rawText = input.value.trim();
    var hasPendingFiles = FileUpload.getPendingCount() > 0;
    // Allow sending with just files attached (no text needed)
    if ((!rawText && !hasPendingFiles) || AppState.isGenerating) return;

    // SECURITY: Rate limiting (fixes H4)
    if (!Security.checkRateLimit('send_message', AppConfig.RATE_LIMIT_SEND_REQUESTS, AppConfig.RATE_LIMIT_SEND_WINDOW_MS)) {
        setStatus('Please slow down — rate limited');
        return;
    }

    // SECURITY: Input sanitization (fixes C5)
    var text = rawText ? Security.sanitizeInput(rawText, AppConfig.MAX_INPUT_LENGTH) : '';
    if (!text && !hasPendingFiles) {
        setStatus('Message was empty after sanitization');
        return;
    }
    // Default prompt when only files are attached
    if (!text && hasPendingFiles) {
        text = 'Analyze the attached document(s) and summarize their contents.';
    }

    if (!AppState.selectedModel) {
        setStatus('No running model selected');
        return;
    }
    if (!Security.isSafeApiBase(AppState.currentBaseUrl)) {
        setStatus('Unsafe API base URL');
        return;
    }
    if (AppConfig.REQUIRE_API_KEY && !String(AppConfig.LMSTUDIO_API_KEY || '').trim()) {
        setStatus('Configure API key in js/config.js');
        return;
    }

    if (AppState.currentChatIndex === null) newChat();
    var chat = AppState.chats[AppState.currentChatIndex];

    // Check max messages per chat
    if (chat.messages.length >= AppConfig.MAX_MESSAGES_PER_CHAT) {
        setStatus('Chat message limit reached — start a new chat');
        return;
    }

    addMessage({ role: 'user', content: text }, 'user');
    chat.messages.push({ role: 'user', content: text });

    if (chat.messages.length === 1) {
        chat.title = makeSmartTitle(text);
    }

    input.value = '';
    autoGrowTextarea(input);
    saveChats();
    renderChatList();
    updateHeader();

    AppState.isGenerating = true;
    AppState.currentAbortController = new AbortController();
    var requestId = ++AppState.generationToken;
    morphSendBtn('stop');
    setStatus('Thinking...');
    var pill = document.getElementById('headerPill');
    if (pill) pill.innerHTML = '<span class="typing"><span></span><span></span><span></span></span> Generating reply';

    AppState.activePlaceholder = buildLivePlaceholderNode(AppState.selectedModel);
    AppState.activePlaceholderChatIndex = AppState.currentChatIndex;
    var messagesDiv = document.getElementById('messages');
    var empty = document.getElementById('emptyState');
    if (empty) empty.remove();
    messagesDiv.appendChild(AppState.activePlaceholder);
    scrollToBottom();
    AppState.activeLiveAssistant = AppState.activePlaceholder;

    // Handle attached files — consume pending uploads
    var attachedFiles = FileUpload.consumePendingFiles();
    var fileContext = '';
    if (attachedFiles.length) {
        fileContext = FileUpload.buildFileContext(attachedFiles);
        FileUpload.trackFilesForChat(AppState.currentChatIndex, attachedFiles);
        // Show file attachment note in chat
        var fileNames = attachedFiles.map(function (f) { return f.name; }).join(', ');
        addSystemNote('\uD83D\uDCCE Attached: ' + fileNames);
        chat.messages.push({ role: 'system', content: '\uD83D\uDCCE Files attached: ' + fileNames });
        saveChats();
    }

    var payloadMessages = buildPayload(chat.messages);

    // Inject file content directly into the user's prompt instead of a system message
    // Many local models (like Gemma) fail entirely when given a 'system' role.
    if (fileContext && payloadMessages.length > 0) {
        var lastMsg = payloadMessages[payloadMessages.length - 1];
        lastMsg.content = fileContext + '\n\nUser Query:\n' + lastMsg.content;
    }

    if (AppState.thinkingEnabled && AppState.thinkingSupported && payloadMessages.length > 0) {
        var firstMsg = payloadMessages[0];
        firstMsg.content = buildThinkingPrompt(AppState.searchEnabled).content + '\n\n' + firstMsg.content;
    }

    // Inject memory context into the first message
    var memoryCtx = buildMemoryContext();
    if (memoryCtx && payloadMessages.length > 0) {
        var firstMsgMem = payloadMessages[0];
        firstMsgMem.content = memoryCtx + '\n\n' + firstMsgMem.content;
    }

    // Inject real-time context into the latest message
    if (payloadMessages.length > 0) {
        var lastUserMsg = payloadMessages[payloadMessages.length - 1];
        if (lastUserMsg.role === 'user') {
            lastUserMsg.content = buildTimeContext() + '\n\n' + lastUserMsg.content;
        }
    }

    var startedAt = performance.now();
    var retryCount = 0;
    var maxRetries = 60; // 2 minutes max queue time
    
    function handleQueueWait(errReason) {
        if (requestId !== AppState.generationToken || !AppState.isGenerating) return;
        retryCount++;
        if (retryCount > maxRetries) {
            finalizeError('Queue timeout: LM Studio never responded. (' + errReason + ')');
            return;
        }
        
        setStatus('Model busy, waiting in queue... (' + retryCount + ')');
        var pill = document.getElementById('headerPill');
        if (pill) pill.innerHTML = '<span class="typing"><span></span><span></span><span></span></span> In Queue...';
        
        if (AppState.activePlaceholder) {
            var msgDiv = AppState.activePlaceholder.querySelector('.message.bot');
            if (msgDiv) msgDiv.innerHTML = '<div class="message-inner">' +
                '<div class="message-meta">' + Security.escapeHtml(AppState.selectedModel || 'AI Server') + ' <i class="ri-time-line"></i></div>' +
                '<div class="message-text" style="color:var(--text-light);"><em><i class="ri-loader-4-line spinner"></i> ' + 
                'Server is currently generating a response for another device.<br>You are in a queue, please hold...</em></div>' +
                '</div>';
        }
        
        // Wait 2 seconds before retrying exactly the same payload
        setTimeout(tryGenerate, 2000);
    }
    
    function finalizeError(errMsg) {
        if (AppState.activePlaceholder && AppState.activePlaceholderChatIndex === AppState.currentChatIndex) {
            AppState.activePlaceholder.className = 'message-container system';
            AppState.activePlaceholder.innerHTML =
                '<div class="message system">' +
                '<div class="message-inner">' +
                '<div class="message-meta"><span class="stopped-note">system note</span></div>' +
                '<div class="stopped-note">' + Security.escapeHtml(errMsg || 'connection error') + '</div>' +
                '</div></div>' +
                '<div class="message-footer system"></div>';
        } else {
            addSystemNote(errMsg || 'connection error');
        }
        setStatus('Error');
        var headerPill = document.getElementById('headerPill');
        if (headerPill) headerPill.textContent = '⚠️ Connection issue';
        
        cleanupState();
    }
    
    function cleanupState() {
        if (requestId === AppState.generationToken) {
            AppState.isGenerating = false;
            AppState.currentAbortController = null;
            morphSendBtn('send');
            AppState.activePlaceholder = null;
            AppState.activePlaceholderChatIndex = null;
            AppState.activeLiveAssistant = null;
            AppState.activeLiveAssistantSources = null;
        }
        scrollToBottom();
    }

    function tryGenerate() {
        var latestRaw = '';
        var thinkingEndTime = 0;
        
        streamChatCompletion({
            model: AppState.selectedModel,
            messages: payloadMessages,
            temperature: 0.7,
            stream: true
        }, AppState.currentAbortController.signal, function (liveText, done) {
            latestRaw = liveText;
            if (!thinkingEndTime && /<\/think>/i.test(liveText)) {
                thinkingEndTime = performance.now();
            }
            if (AppState.activePlaceholder && AppState.activePlaceholderChatIndex === AppState.currentChatIndex) {
                updateActiveAssistantLive(liveText, startedAt, thinkingEndTime);
                scrollToBottom();
            }
        })
        .then(function (result) {
            if (requestId !== AppState.generationToken) return;

            latestRaw = (result && result.rawText) || latestRaw || '';
            var parsed = extractThinkingFromReply(latestRaw);
            var finalText = parsed.finalText || latestRaw || '';
            finalText = finalText.trim();
            
            // Queue Condition 1: Empty response (LM Studio drops connection immediately when busy)
            if (!finalText && !parsed.thinking) {
                return handleQueueWait('empty response');
            }

            var actualThinkingDuration = thinkingEndTime ? (thinkingEndTime - startedAt) / 1000 : 0;
            var totalDuration = (performance.now() - startedAt) / 1000;
            var assistantMessage = {
                role: 'assistant',
                content: finalText,
                thinking: parsed.thinking || '',
                thinkingDuration: parsed.thinking ? actualThinkingDuration : 0,
                model: AppState.selectedModel,
                usage: result && result.usage,
                finishReason: result && result.finishReason,
                totalDuration: totalDuration,
                sources: AppState.activeLiveAssistantSources || []
            };

            if (AppState.activePlaceholder && AppState.activePlaceholderChatIndex === AppState.currentChatIndex) {
                AppState.activePlaceholder.replaceWith(buildFinalAssistantNode(assistantMessage));
            } else {
                addMessage(assistantMessage, 'bot', true, AppState.selectedModel);
            }

            chat.messages.push(assistantMessage);
            saveChats();
            renderChatList();
            updateHeader();
            setStatus('Ready');
            var headerPill = document.getElementById('headerPill');
            if (headerPill) headerPill.textContent = '✨ Reply ready';
            
            cleanupState();
        })
        .catch(function (e) {
            if (requestId !== AppState.generationToken) return;
            if (e.name === 'AbortError') return cleanupState();

            // Queue Condition 2: HTTP error indicating busy/dropped server
            var errMsg = String(e.message || e);
            var errLower = errMsg.toLowerCase();
            if (errLower.indexOf('http') !== -1 || errLower.indexOf('network') !== -1 || errLower.indexOf('fetch') !== -1 || errLower.indexOf('failed') !== -1) {
                return handleQueueWait(errMsg);
            }

            finalizeError(errMsg);
        });
    }

    if (AppState.searchEnabled && AppConfig.TAVILY_API_KEY) {
        setStatus('Refining search query...');
        var hp = document.getElementById('headerPill');
        if (hp) hp.innerHTML = '<span class="typing"><span></span><span></span><span></span></span> Refining search';

        generateSearchQuery(payloadMessages)
            .then(function(refinedQuery) {
                if (requestId !== AppState.generationToken) return;
                
                setStatus('Scraping websites... (' + refinedQuery + ')');
                if (hp) hp.innerHTML = '<span class="typing"><span></span><span></span><span></span></span> Web Search active';

                return executeTavilySearch(refinedQuery).then(function(results) {
                    if (requestId !== AppState.generationToken) return;
                    
                    setStatus('Analyzing and filtering sources...');
                    var contextStr = '';
                    var sourcesMap = {};
                    var sources = [];
                    for (var i = 0; i < results.length; i++) {
                        if (!sourcesMap[results[i].url]) {
                            sourcesMap[results[i].url] = true;
                            sources.push({ url: results[i].url, title: results[i].title });
                        }
                        contextStr += '[' + (sources.length) + '] Title: ' + results[i].title + '\nURL: ' + results[i].url + '\nContent: ' + results[i].content + '\n\n';
                    }
                    if (contextStr) {
                        var lastMsg = payloadMessages[payloadMessages.length - 1];
                        lastMsg.content = "SYSTEM INSTRUCTION (RESEARCH MODE): You are a professional researcher. Using the Web Search Context provided below, generate an EXTREMELY DETAILED, COMPREHENSIVE, and LONG-FORM response. Organize your findings into logical sections. Cite all claims using [1], [2], etc. Do not omit any relevant details. Use as much depth as possible.\n\n" + 
                                         "Web Search Context:\n" + contextStr + "\n\nUser Query: " + lastMsg.content;
                        AppState.activeLiveAssistantSources = sources;
                    } else {
                        AppState.activeLiveAssistantSources = [];
                    }
                    tryGenerate();
                });
            })
            .catch(function(err) {
                console.error('[Search] Error:', err);
                addSystemNote('Search Error: ' + err.message);
                AppState.activeLiveAssistantSources = [];
                tryGenerate();
            });
    } else {
        AppState.activeLiveAssistantSources = [];
        tryGenerate();
    }
}

/* ───────────────────────────────────────────────
 *  SEND/STOP BUTTON MORPH
 * ─────────────────────────────────────────────── */
function morphSendBtn(mode) {
    var btn = document.getElementById('sendBtn');
    if (!btn) return;
    if (mode === 'stop') {
        btn.className = 'send is-stop';
        btn.innerHTML = '<i class="ri-stop-fill"></i> Stop';
        btn.disabled = false;
    } else {
        btn.className = 'send';
        btn.innerHTML = '<i class="ri-send-plane-2-line"></i> Send';
        btn.disabled = false;
    }
}

/* ───────────────────────────────────────────────
 *  EVENT DELEGATION (eliminates inline onclick)
 * ─────────────────────────────────────────────── */
function setupEventDelegation() {
    document.addEventListener('click', function (e) {
        var target = e.target.closest('[data-action]');
        if (!target) return;

        var action = target.getAttribute('data-action');
        switch (action) {
            case 'new-chat':
                newChat();
                break;
            case 'discover-models':
                discoverModels();
                break;
            case 'toggle-desktop-sidebar':
                toggleDesktopSidebar();
                break;
            case 'toggle-sidebar':
                toggleSidebar();
                break;
            case 'toggle-sidebar-overlay':
                toggleSidebar();
                break;
            case 'toggle-thinking':
                // Toggle thinking card collapse
                var card = target.closest('.thinking-card');
                if (card) card.classList.toggle('collapsed');
                break;
            case 'thinking-mode':
                toggleThinkingMode();
                break;
            case 'search-mode':
                toggleSearchMode();
                break;
            case 'stop-generation':
                stopGeneration();
                break;
            case 'send-message':
                if (AppState.isGenerating) {
                    stopGeneration();
                } else {
                    sendMessage();
                }
                break;
            case 'open-model-manager':
                openModelManager();
                break;
            case 'close-model-manager':
                closeModelManager();
                break;
            case 'copy-code':
                copyCodeBlock(target);
                break;
            case 'attach-file':
                var fileInput = document.getElementById('fileInput');
                if (fileInput) fileInput.click();
                break;
            case 'open-memory-manager':
                openMemoryManager();
                break;
            case 'close-memory-manager':
                closeMemoryManager();
                break;
            case 'add-memory':
                addMemory();
                break;
            case 'delete-memory':
                var memIdx = parseInt(target.getAttribute('data-memory-index'), 10);
                if (!isNaN(memIdx)) deleteMemory(memIdx);
                break;
            case 'open-settings':
                openSettings();
                break;
            case 'close-settings':
                closeSettings();
                break;
            case 'save-settings':
                saveSettings();
                break;
        }
    });

    // File input change handler
    document.addEventListener('change', function (e) {
        if (e.target.id === 'fileInput') {
            FileUpload.handleFileInput(e.target);
        }
    });

    // Select change handler
    document.addEventListener('change', function (e) {
        if (e.target.id === 'modelSelect') {
            selectModelFromUI();
        }
    });

    // Overlay click handler for model manager
    var mmOverlay = document.getElementById('modelManagerOverlay');
    if (mmOverlay) {
        mmOverlay.addEventListener('click', function (e) {
            if (e.target === mmOverlay) closeModelManager();
        });
    }

    // Sidebar overlay click handler
    var sidebarOverlay = document.getElementById('sidebarOverlay');
    if (sidebarOverlay) {
        sidebarOverlay.addEventListener('click', function () {
            toggleSidebar();
        });
    }

    // Overlay click handler for memory manager
    var memOverlay = document.getElementById('memoryManagerOverlay');
    if (memOverlay) {
        memOverlay.addEventListener('click', function (e) {
            if (e.target === memOverlay) closeMemoryManager();
        });
    }

    // Overlay click handler for settings
    var settingsOverlay = document.getElementById('settingsOverlay');
    if (settingsOverlay) {
        settingsOverlay.addEventListener('click', function (e) {
            if (e.target === settingsOverlay) closeSettings();
        });
    }
}

/* ───────────────────────────────────────────────
 *  WIRE UP (keyboard events)
 * ─────────────────────────────────────────────── */
function wireUp() {
    var input = document.getElementById('input');
    input.addEventListener('input', function (e) { autoGrowTextarea(e.target); });
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendMessage();
        }
    });
}

/* ───────────────────────────────────────────────
 *  INIT (with error boundary — fixes L2)
 * ─────────────────────────────────────────────── */
function init() {
    try {
        // Load persisted state
        loadPersistedState();

        // Setup UI
        wireUp();
        setupEventDelegation();
        renderChatList();
        updateHeader();
        showEmptyState();

        // Restore desktop sidebar collapsed state
        if (Security.SafeStorage.get('sidebar_collapsed') === 'true') {
            var app = document.querySelector('.app');
            if (app) app.classList.add('sidebar-collapsed');
        }

        // Discover models, then do a full v1 refresh to accurately
        // detect loaded models (v0 endpoint may miss state info)
        discoverModels().then(function () {
            if (AppState.currentBaseUrl) {
                return refreshAfterModelChange();
            }
            renderModelSelect();
            updateHeader();
            syncThinkingAvailability();
        }).then(function() {
            // Start polling the server in the background
            if (typeof startServerPolling === 'function') {
                startServerPolling();
            }
        });

    } catch (err) {
        console.error('[Init] Critical error during initialization:', err);
        setStatus('Initialization error — check console');
    }
}

// Start the application
init();
