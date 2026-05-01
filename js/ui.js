/**
 * UI Module — DOM manipulation, rendering, sidebar, clipboard.
 * All innerHTML assignments use Security.escapeHtml for user-influenced content.
 * Inline onclick handlers replaced with data-action event delegation.
 */
'use strict';

/* ───────────────────────────────────────────────
 *  CLIPBOARD
 * ─────────────────────────────────────────────── */
function copyText(text) {
    var value = String(text || '');
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value)
            .then(function () { setStatus('Copied to clipboard'); })
            .catch(function () { _fallbackCopy(value); });
    } else {
        _fallbackCopy(value);
    }
}

function _fallbackCopy(value) {
    var ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    ta.style.top = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); setStatus('Copied to clipboard'); } catch (_e) { }
    document.body.removeChild(ta);
}

function copyCodeBlock(button) {
    var copyId = button.getAttribute('data-copy-id');
    if (copyId !== null) {
        copyText(AppState._copyRegistry[Number(copyId)] || '');
    }
}

function copyRegistered(id) {
    copyText(AppState._copyRegistry[id] || '');
}

/* ───────────────────────────────────────────────
 *  STATUS & HEADER
 * ─────────────────────────────────────────────── */
function setStatus(text) {
    var el = document.getElementById('status');
    if (el) el.textContent = text;
}

function updateHeader() {
    var chat = AppState.currentChatIndex !== null ? AppState.chats[AppState.currentChatIndex] : null;
    var chipEl = document.getElementById('selectedModelChip');
    var apiEl = document.getElementById('apiBaseText');
    if (chipEl) chipEl.textContent = AppState.selectedModel || 'No model selected';
    if (apiEl) apiEl.textContent = AppState.currentBaseUrl;

    var nameEl = document.getElementById('chatName');
    var subEl = document.getElementById('chatSubtitle');
    var pillEl = document.getElementById('headerPill');

    if (!chat) {
        if (nameEl) nameEl.textContent = 'No chat selected';
        if (subEl) subEl.textContent = 'Start a conversation to generate a smart title.';
        if (pillEl) pillEl.textContent = '⚡ Ready for your next message';
        return;
    }

    if (nameEl) nameEl.textContent = chat.title || 'Untitled chat';
    if (subEl) subEl.textContent = chat.messages.length
        ? chat.messages.length + ' message' + (chat.messages.length === 1 ? '' : 's') + ' in this conversation'
        : 'This chat is waiting for your first message.';
    if (pillEl) pillEl.textContent = chat.messages.length ? '✨ Reply ready' : '⚡ Ready for your next message';
}

function updateServerStatusUI(isOnline) {
    var dot = document.getElementById('serverStatusDot');
    var text = document.getElementById('serverStatusText');
    var statusDiv = document.getElementById('serverStatus');
    var discoverBtn = document.getElementById('discoverBtn');
    var manageModelsBtn = document.getElementById('manageModelsBtn');
    var modelSelect = document.getElementById('modelSelect');
    var sendBtn = document.getElementById('sendBtn');
    
    if (dot && text && statusDiv) {
        dot.className = 'status-dot ' + (isOnline ? 'online' : 'offline');
        text.textContent = isOnline ? 'Online' : 'Offline';
        statusDiv.title = isOnline ? 'Server is reachable' : 'Server is offline or disconnected';
    }

    if (manageModelsBtn) manageModelsBtn.disabled = !isOnline;
    if (discoverBtn) discoverBtn.disabled = !isOnline;
    if (modelSelect) modelSelect.disabled = !isOnline || AppState.models.length === 0;
    if (sendBtn) sendBtn.disabled = !isOnline;
    
    if (!isOnline) {
        setStatus('Server disconnected. Please turn on your host device.');
    } else if (document.getElementById('status').textContent.indexOf('disconnected') !== -1) {
        setStatus('Ready');
    }
}

/* ───────────────────────────────────────────────
 *  THINKING MODE
 * ─────────────────────────────────────────────── */
function detectThinkingCapability(modelName) {
    var name = String(modelName || '').toLowerCase();
    if (!name) return false;
    return /think|reason|reasoning|r1|qwq|deepseek|gemma-4|qwen3|o1|o3|thought/.test(name);
}

function syncThinkingAvailability() {
    var btn = document.getElementById('thinkBtn');
    AppState.thinkingSupported = detectThinkingCapability(AppState.selectedModel);
    if (!AppState.thinkingSupported) AppState.thinkingEnabled = false;
    if (!btn) return;
    btn.disabled = !AppState.thinkingSupported;
    btn.classList.toggle('is-on', AppState.thinkingEnabled && AppState.thinkingSupported);
    btn.title = AppState.thinkingSupported
        ? (AppState.thinkingEnabled ? 'Thinking mode on' : 'Thinking mode off')
        : 'Thinking not detected for this model';
    var label = btn.querySelector('span');
    if (label) label.textContent = 'Think';
}

function toggleThinkingMode() {
    if (!detectThinkingCapability(AppState.selectedModel)) {
        syncThinkingAvailability();
        setStatus('Thinking not detected for this model');
        return;
    }
    AppState.thinkingEnabled = !AppState.thinkingEnabled;
    syncThinkingAvailability();
    setStatus(AppState.thinkingEnabled ? 'Thinking mode on' : 'Thinking mode off');
}

function toggleSearchMode() {
    var key = String(AppConfig.TAVILY_API_KEY || '').trim();
    var isNetlify = window.location.hostname.indexOf('netlify.app') !== -1;

    // Block only if there is no local key AND we're not on Netlify
    // (On Netlify, the serverless proxy provides the key securely)
    if (!key && !isNetlify) {
        showToast('Tavily API Key missing in js/config.js. Please add it there to enable Web Search.', true);
        return;
    }
    
    AppState.searchEnabled = !AppState.searchEnabled;
    
    var btn = document.getElementById('searchBtn');
    if (btn) {
        if (AppState.searchEnabled) {
            btn.classList.add('is-on');
            btn.querySelector('span').textContent = 'Searching';
        } else {
            btn.classList.remove('is-on');
            btn.querySelector('span').textContent = 'Search';
        }
    }
    
    showToast(AppState.searchEnabled ? 'Web Search active' : 'Web Search disabled');
    setStatus(AppState.searchEnabled ? 'Web Search enabled' : 'Ready');
}

/* ───────────────────────────────────────────────
 *  THINKING CARD
 * ─────────────────────────────────────────────── */
function buildThinkingCard(thinking, durationSeconds, collapsed) {
    collapsed = collapsed !== false;
    var durationLabel = (Number.isFinite(durationSeconds) && durationSeconds > 0)
        ? 'Thought for ' + durationSeconds.toFixed(1) + ' seconds'
        : 'Thinking';
    var body = formatText(thinking);
    return '<div class="thinking-card' + (collapsed ? ' collapsed' : '') + '">' +
        '<button class="thinking-head" type="button" data-action="toggle-thinking">' +
        '<span class="thinking-head-left"><i class="ri-lightbulb-flash-line"></i><span>Thinking</span></span>' +
        '<span class="thinking-time">' + Security.escapeHtml(durationLabel) + '</span>' +
        '<i class="ri-arrow-down-s-line thinking-chevron"></i>' +
        '</button>' +
        '<div class="thinking-body">' +
        '<div class="message-text">' + body + '</div>' +
        '</div></div>';
}

/* ───────────────────────────────────────────────
 *  MESSAGE RENDERING
 * ─────────────────────────────────────────────── */
function renderAssistantMessageContent(messageObj, live) {
    var data = normalizeMessagePayload(messageObj);
    var hasThinking = !live && Boolean(data.thinking && data.thinking.trim());
    var thinkingHtml = hasThinking ? buildThinkingCard(data.thinking, data.thinkingDuration, true) : '';
    var bodyHtml = live ? formatLiveStreamingBody(data.content) : formatAssistantBody(data.content);

    var metricsHtml = '';
    if (!live && (data.usage || data.totalDuration > 0)) {
        var speed = '';
        var tokens = (data.usage && (data.usage.total_tokens || data.usage.completion_tokens)) || 0;
        if (tokens && data.totalDuration > 0) {
            speed = (tokens / data.totalDuration).toFixed(2);
        }
        metricsHtml = '<div class="metrics-row">';
        if (speed) metricsHtml += '<span class="metric-pill" title="Tokens per second"><i class="ri-flashlight-line"></i> ' + speed + ' tok/sec</span>';
        if (tokens) metricsHtml += '<span class="metric-pill" title="Tokens used"><i class="ri-stack-line"></i> ' + tokens + ' tokens</span>';
        if (data.totalDuration > 0) metricsHtml += '<span class="metric-pill" title="Generation time"><i class="ri-timer-line"></i> ' + data.totalDuration.toFixed(2) + 's</span>';
        if (data.finishReason && data.finishReason !== 'undefined') metricsHtml += '<span class="metric-pill" title="Stop reason">Stop reason: ' + Security.escapeHtml(data.finishReason) + '</span>';
        metricsHtml += '</div>';
    }

    var sourcesHtml = renderSourcesList(data.sources);

    return '<div class="message-inner">' +
        '<div class="message-meta">' + Security.escapeHtml(data.model || AppState.selectedModel || 'AI model') + '</div>' +
        '<div class="assistant-stack">' +
        thinkingHtml +
        '<div class="assistant-final">' + bodyHtml + '</div>' +
        sourcesHtml +
        metricsHtml +
        '</div></div>';
}

function renderUserOrSystemContent(messageObj, role) {
    var data = normalizeMessagePayload(messageObj);
    if (role === 'system') {
        return '<div class="message-inner">' +
            '<div class="message-meta"><span class="stopped-note">system note</span></div>' +
            '<div class="stopped-note">' + Security.escapeHtml(data.content) + '</div>' +
            '</div>';
    }
    return '<div class="message-inner">' +
        '<div class="message-meta"><i class="ri-user-3-line"></i> You</div>' +
        '<div class="message-text">' + formatText(data.content) + '</div>' +
        '</div>';
}

/* ───────────────────────────────────────────────
 *  MESSAGE NODE CONSTRUCTION (DOM-based — fixes C4)
 * ─────────────────────────────────────────────── */
function buildMessageNode(text, role, modelName) {
    var messageObj = normalizeMessagePayload(text);
    var roleName = role || messageObj.role || '';
    var container = document.createElement('div');
    container.className = 'message-container ' + roleName;

    var wrap = document.createElement('div');
    wrap.className = 'message ' + roleName;

    if (roleName === 'bot' || roleName === 'assistant') {
        wrap.innerHTML = renderAssistantMessageContent(messageObj, false);
    } else if (roleName === 'user' || roleName === 'system') {
        wrap.innerHTML = renderUserOrSystemContent(messageObj, roleName);
    } else {
        wrap.innerHTML = '<div class="message-inner">' +
            '<div class="message-meta">' + Security.escapeHtml(modelName || AppState.selectedModel || 'AI model') + '</div>' +
            '<div class="message-text">' + formatText(messageObj.content) + '</div>' +
            '</div>';
    }

    var footer = document.createElement('div');
    footer.className = 'message-footer ' + roleName;
    if (roleName !== 'system') {
        var copyBtn = document.createElement('button');
        copyBtn.className = 'msg-action';
        copyBtn.title = 'Copy message';
        copyBtn.innerHTML = '<i class="ri-file-copy-line"></i> Copy';
        // Use closure to capture the text safely (no inline JS with user content)
        var copyContent = (roleName === 'bot' || roleName === 'assistant')
            ? [messageObj.thinking, messageObj.content].filter(Boolean).join(messageObj.thinking ? '\n\n' : '')
            : messageObj.content;
        copyBtn.addEventListener('click', function () { copyText(copyContent); });
        footer.appendChild(copyBtn);
    }

    container.appendChild(wrap);
    container.appendChild(footer);
    return container;
}

function buildFinalAssistantNode(messageObj) {
    var node = document.createElement('div');
    node.className = 'message-container bot';
    var data = normalizeMessagePayload(messageObj);

    var wrap = document.createElement('div');
    wrap.className = 'message bot';
    wrap.innerHTML = renderAssistantMessageContent(data, false);

    var footer = document.createElement('div');
    footer.className = 'message-footer bot';
    var copyBtn = document.createElement('button');
    copyBtn.className = 'msg-action';
    copyBtn.title = 'Copy message';
    copyBtn.innerHTML = '<i class="ri-file-copy-line"></i> Copy';
    var fullText = [data.thinking, data.content].filter(Boolean).join(data.thinking ? '\n\n' : '');
    copyBtn.addEventListener('click', function () { copyText(fullText); });
    footer.appendChild(copyBtn);

    node.appendChild(wrap);
    node.appendChild(footer);
    return node;
}

function buildLivePlaceholderNode(modelName) {
    var container = document.createElement('div');
    container.className = 'message-container bot';
    container.innerHTML = '<div class="message bot">' +
        '<div class="message-inner">' +
        '<div class="message-meta">' + Security.escapeHtml(modelName || AppState.selectedModel || 'AI model') + '</div>' +
        '<div class="assistant-stack">' +
        '<div class="assistant-final"><div class="message-text"><span class="typing"><span></span><span></span><span></span></span></div></div>' +
        '</div></div></div>' +
        '<div class="message-footer bot"></div>';
    return container;
}

/* ───────────────────────────────────────────────
 *  ADD / RENDER MESSAGES
 * ─────────────────────────────────────────────── */
function addMessage(text, role, saveToDom, modelName) {
    var messagesDiv = document.getElementById('messages');
    var empty = document.getElementById('emptyState');
    if (empty) empty.remove();
    var node = buildMessageNode(
        typeof text === 'object' ? text : { role: role, content: text, model: modelName },
        role,
        modelName
    );
    messagesDiv.appendChild(node);
    if (saveToDom !== false) scrollToBottom();
}

function addSystemNote(text, saveToDom) {
    var messagesDiv = document.getElementById('messages');
    var empty = document.getElementById('emptyState');
    if (empty) empty.remove();
    messagesDiv.appendChild(buildMessageNode({ role: 'system', content: text }, 'system', ''));
    if (saveToDom !== false) scrollToBottom();
}

function renderMessages() {
    var messagesDiv = document.getElementById('messages');
    messagesDiv.innerHTML = '';
    var chat = AppState.currentChatIndex !== null ? AppState.chats[AppState.currentChatIndex] : null;
    if (!chat || !chat.messages.length) {
        showEmptyState();
        return;
    }
    for (var i = 0; i < chat.messages.length; i++) {
        var m = chat.messages[i];
        if (m.role === 'system') {
            addSystemNote(m.content, false);
        } else if (m.role === 'bot' || m.role === 'assistant') {
            messagesDiv.appendChild(buildFinalAssistantNode(m));
        } else {
            addMessage(m, m.role, false, m.model || '');
        }
    }
    messagesDiv.scrollTop = messagesDiv.scrollHeight;
}

/* ───────────────────────────────────────────────
 *  CHAT LIST & MANAGEMENT (DOM-based — fixes C4)
 * ─────────────────────────────────────────────── */
function renderChatList() {
    var list = document.getElementById('chatList');
    list.innerHTML = '<div class="section-label">Conversations</div>';

    for (var idx = 0; idx < AppState.chats.length; idx++) {
        (function (index) {
            var chat = AppState.chats[index];
            var item = document.createElement('div');
            item.className = 'chat-item' + (index === AppState.currentChatIndex ? ' active' : '');
            item.addEventListener('click', function () { loadChat(index); });

            var titleWrap = document.createElement('div');
            titleWrap.className = 'chat-title-wrap';

            var title = document.createElement('div');
            title.className = 'chat-title';
            title.textContent = chat.title || 'Untitled chat';

            var meta = document.createElement('div');
            meta.className = 'chat-meta';
            var msgCount = (chat.messages && chat.messages.length) || 0;
            meta.textContent = msgCount + ' message' + (msgCount === 1 ? '' : 's');

            titleWrap.appendChild(title);
            titleWrap.appendChild(meta);

            var actions = document.createElement('div');
            actions.className = 'chat-actions';

            var renameBtn = document.createElement('button');
            renameBtn.className = 'icon-btn rename-btn';
            renameBtn.title = 'Rename conversation';
            renameBtn.innerHTML = '<i class="ri-edit-2-line"></i>';
            renameBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                var newName = prompt('Enter new chat name:', AppState.chats[index].title || 'Untitled chat');
                if (newName && newName.trim()) {
                    // Sanitize the new title (fixes M3)
                    AppState.chats[index].title = Security.validateChatTitle(newName.trim());
                    saveChats();
                    renderChatList();
                    updateHeader();
                }
            });

            var deleteBtn = document.createElement('button');
            deleteBtn.className = 'icon-btn delete-btn';
            deleteBtn.title = 'Delete conversation';
            deleteBtn.innerHTML = '<i class="ri-delete-bin-6-line"></i>';
            deleteBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (confirm('Delete this chat?')) {
                    AppState.chats.splice(index, 1);
                    if (AppState.currentChatIndex === index) {
                        AppState.currentChatIndex = null;
                        document.getElementById('messages').innerHTML = '';
                        showEmptyState();
                    } else if (AppState.currentChatIndex > index) {
                        AppState.currentChatIndex -= 1;
                    }
                    saveChats();
                    renderChatList();
                    updateHeader();
                }
            });

            actions.appendChild(renameBtn);
            actions.appendChild(deleteBtn);
            item.appendChild(titleWrap);
            item.appendChild(actions);
            list.appendChild(item);
        })(idx);
    }
}

function showEmptyState() {
    var messagesDiv = document.getElementById('messages');
    if (!messagesDiv.querySelector('.message')) {
        messagesDiv.innerHTML = '<div class="empty-state" id="emptyState">' +
            '<h2>Welcome</h2>' +
            '<p>Start a chat, ask a question, or continue an existing conversation from the sidebar.</p>' +
            '</div>';
    }
}

function newChat() {
    var chat = { title: 'New Chat', messages: [] };
    AppState.chats.push(chat);
    AppState.currentChatIndex = AppState.chats.length - 1;
    saveChats();
    renderChatList();
    renderMessages();
    updateHeader();
}

function loadChat(index) {
    AppState.currentChatIndex = index;
    renderMessages();
    renderChatList();
    updateHeader();
}

/* ───────────────────────────────────────────────
 *  PAYLOAD BUILDING
 * ─────────────────────────────────────────────── */
function buildPayload(messages) {
    var cleaned = [];
    var lastRole = null;
    for (var i = 0; i < messages.length; i++) {
        var m = messages[i];
        if (m.role === 'system') continue;
        if (!lastRole) {
            if (m.role === 'user') {
                cleaned.push({ role: m.role, content: m.content });
                lastRole = 'user';
            }
            continue;
        }
        if (m.role !== lastRole) {
            cleaned.push({ role: m.role, content: m.content });
            lastRole = m.role;
        }
    }
    if (cleaned.length && cleaned[cleaned.length - 1].role === 'assistant') cleaned.pop();
    var trimmed = cleaned.slice(-AppConfig.MAX_CONTEXT_MESSAGES);
    if (trimmed.length && trimmed[0].role !== 'user') trimmed.shift();
    return trimmed;
}

/* ───────────────────────────────────────────────
 *  UTILITY
 * ─────────────────────────────────────────────── */
function autoGrowTextarea(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 170) + 'px';
}

function scrollToBottom() {
    var el = document.getElementById('messages');
    if (el) el.scrollTop = el.scrollHeight;
}

/* ───────────────────────────────────────────────
 *  LIVE STREAMING UPDATES
 * ─────────────────────────────────────────────── */
function fillTypingPlaceholder() {
    if (!AppState.activePlaceholder) return;
    var msgDiv = AppState.activePlaceholder.querySelector('.message.bot');
    if (!msgDiv) return;
    msgDiv.innerHTML = '<div class="message-inner">' +
        '<div class="message-meta">' + Security.escapeHtml(AppState.selectedModel || 'AI model') + '</div>' +
        '<div class="assistant-stack">' +
        '<div class="assistant-final"><div class="message-text"><span class="typing"><span></span><span></span><span></span></span></div></div>' +
        '</div></div>';
}

function updateActiveAssistantLive(text, startedAt, thinkingEndTime) {
    if (!AppState.activePlaceholder) return;
    var liveText = String(text || '');
    var parsed = extractThinkingFromReply(liveText);

    // Calculate thinking duration accurately
    var thinkingDuration = 0;
    if (parsed.thinking) {
        if (thinkingEndTime) {
            // </think> tag found — use the frozen time
            thinkingDuration = (thinkingEndTime - startedAt) / 1000;
        } else {
            // Still thinking (no </think> yet) — show live ticking time
            thinkingDuration = startedAt ? (performance.now() - startedAt) / 1000 : 0;
        }
    }

    var thinkingHtml = '';
    if (parsed.thinking) {
        thinkingHtml = buildThinkingCard(parsed.thinking, thinkingDuration, false);
    }

    var bodyHtml = formatLiveStreamingBody(parsed.finalText);
    var msgDiv = AppState.activePlaceholder.querySelector('.message.bot');
    if (!msgDiv) return;
    msgDiv.innerHTML = '<div class="message-inner">' +
        '<div class="message-meta">' + Security.escapeHtml(AppState.selectedModel || 'AI model') + '</div>' +
        '<div class="assistant-stack">' +
        thinkingHtml +
        '<div class="assistant-final">' + bodyHtml + '</div>' +
        '</div></div>';
}

function setStoppedPlaceholder() {
    if (!AppState.activePlaceholder) return;
    AppState.activePlaceholder.className = 'message-container system';
    AppState.activePlaceholder.innerHTML = '<div class="message system">' +
        '<div class="message-inner">' +
        '<div class="message-meta"><span class="stopped-note">system note</span></div>' +
        '<div class="stopped-note">model was stopped</div>' +
        '</div></div>' +
        '<div class="message-footer system"></div>';
}

/* ───────────────────────────────────────────────
 *  MODEL SELECT
 * ─────────────────────────────────────────────── */
function renderModelSelect() {
    var select = document.getElementById('modelSelect');
    select.innerHTML = '';

    if (!AppState.models.length) {
        var option = document.createElement('option');
        option.value = '';
        option.textContent = 'No running models';
        select.appendChild(option);
        select.disabled = true;
        syncThinkingAvailability();
        return;
    }

    select.disabled = false;
    for (var i = 0; i < AppState.models.length; i++) {
        var opt = document.createElement('option');
        opt.value = AppState.models[i];
        opt.textContent = AppState.models[i];
        if (AppState.models[i] === AppState.selectedModel) opt.selected = true;
        select.appendChild(opt);
    }
    syncThinkingAvailability();
}

function selectModelFromUI() {
    var select = document.getElementById('modelSelect');
    AppState.selectedModel = select.value;
    saveModelSelection();
    syncThinkingAvailability();
    updateHeader();
}

/* ───────────────────────────────────────────────
 *  SIDEBAR TOGGLE
 * ─────────────────────────────────────────────── */
function toggleSidebar() {
    var sidebar = document.getElementById('sidebar');
    var overlay = document.getElementById('sidebarOverlay');
    if (!sidebar) return;
    sidebar.classList.toggle('open');
    if (overlay) {
        if (sidebar.classList.contains('open')) {
            overlay.style.display = 'block';
            setTimeout(function () { overlay.style.opacity = '1'; }, 10);
        } else {
            overlay.style.opacity = '0';
            setTimeout(function () { overlay.style.display = 'none'; }, 300);
        }
    }
}

function toggleDesktopSidebar() {
    var app = document.querySelector('.app');
    app.classList.toggle('sidebar-collapsed');
    var isCollapsed = app.classList.contains('sidebar-collapsed');
    Security.SafeStorage.set('sidebar_collapsed', isCollapsed ? 'true' : 'false');
}

/* ───────────────────────────────────────────────
 *  MEMORY MANAGER UI
 * ─────────────────────────────────────────────── */
function openMemoryManager() {
    var overlay = document.getElementById('memoryManagerOverlay');
    if (!overlay) return;
    renderMemoryList();
    overlay.classList.add('visible');
}

function closeMemoryManager() {
    var overlay = document.getElementById('memoryManagerOverlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
}

function renderMemoryList() {
    var body = document.getElementById('memoryBody');
    if (!body) return;

    if (!AppState.memories.length) {
        body.innerHTML = '<div class="mm-empty">' +
            '<i class="ri-brain-line"></i>' +
            '<div>No memories yet</div>' +
            '<div class="mm-empty-hint">Add facts you want the AI to remember across all chats.<br>Example: "My name is Sarthak" or "I prefer Python"</div>' +
            '</div>';
    } else {
        var html = '<div class="memory-list">';
        for (var i = 0; i < AppState.memories.length; i++) {
            (function (index) {
                html += '<div class="memory-item" data-index="' + index + '">' +
                    '<span class="memory-text">' + Security.escapeHtml(AppState.memories[index]) + '</span>' +
                    '<button class="memory-delete-btn" data-action="delete-memory" data-memory-index="' + index + '" title="Delete memory">' +
                    '<i class="ri-close-line"></i>' +
                    '</button></div>';
            })(i);
        }
        html += '</div>';
        body.innerHTML = html;
    }
}

function addMemory() {
    var input = document.getElementById('memoryInput');
    if (!input) return;
    var text = input.value.trim();
    if (!text) return;
    if (text.length > 500) {
        text = text.slice(0, 500);
    }
    AppState.memories.push(text);
    saveMemories();
    input.value = '';
    renderMemoryList();
    showMemoryToast('Memory saved');
}

function deleteMemory(index) {
    if (index < 0 || index >= AppState.memories.length) return;
    AppState.memories.splice(index, 1);
    saveMemories();
    renderMemoryList();
}

function showMemoryToast(msg) {
    setStatus(msg);
}

/* ───────────────────────────────────────────────
 *  SERVER URL SETTINGS UI
 * ─────────────────────────────────────────────── */
function openSettings() {
    var overlay = document.getElementById('settingsOverlay');
    if (!overlay) return;
    var input = document.getElementById('serverUrlInput');
    var currentDisplay = document.getElementById('settingsCurrentUrl');
    
    // Pre-fill with current base URL
    if (input) {
        input.value = AppState.currentBaseUrl || '';
    }
    // Show current status
    if (currentDisplay) {
        var savedUrl = Security.SafeStorage.get('lmstudio_base_url', '');
        currentDisplay.innerHTML = '<strong>Currently saved:</strong> ' +
            Security.escapeHtml(savedUrl || '(auto-detected)') +
            '<br><strong>Active:</strong> ' +
            Security.escapeHtml(AppState.currentBaseUrl || 'none');
    }
    overlay.classList.add('visible');
}

function closeSettings() {
    var overlay = document.getElementById('settingsOverlay');
    if (!overlay) return;
    overlay.classList.remove('visible');
}

function saveSettings() {
    var input = document.getElementById('serverUrlInput');
    if (!input) return;
    var url = input.value.trim().replace(/\/+$/, '');
    
    if (!url) {
        // Clear saved URL — go back to auto-detection
        Security.SafeStorage.remove('lmstudio_base_url');
        AppState.currentBaseUrl = '';
        closeSettings();
        showToast('Cleared server URL — will auto-detect');
        discoverModels();
        return;
    }
    
    // Basic URL validation
    try {
        new URL(url);
    } catch (_e) {
        showToast('Invalid URL — must start with http:// or https://', true);
        return;
    }
    
    // Save and apply
    AppState.currentBaseUrl = url;
    saveBaseUrl();
    closeSettings();
    showToast('Server URL saved! Connecting...');
    setStatus('Connecting to ' + url + '...');
    
    // Trigger discovery with the new URL
    discoverModels();
}
