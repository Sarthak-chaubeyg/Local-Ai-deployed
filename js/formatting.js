/**
 * Formatting Module — HTML escaping, markdown formatting, code highlighting.
 * All rendering of user/assistant text goes through this module.
 *
 * Uses Security.escapeHtml / Security.escapeAttr for safe output.
 */
'use strict';

/* ───────────────────────────────────────────────
 *  MESSAGE NORMALIZATION
 * ─────────────────────────────────────────────── */
function normalizeMessagePayload(message) {
    if (message && typeof message === 'object') {
        return {
            role: message.role || '',
            content: String(message.content != null ? message.content : (message.text != null ? message.text : '')),
            thinking: String(message.thinking != null ? message.thinking : (message.analysis != null ? message.analysis : '')),
            thinkingDuration: Number(message.thinkingDuration || message.duration || 0) || 0,
            model: String(message.model != null ? message.model : ''),
            usage: message.usage || null,
            finishReason: String(message.finishReason || ''),
            totalDuration: Number(message.totalDuration || 0) || 0,
            sources: message.sources || []
        };
    }
    return {
        role: '',
        content: String(message != null ? message : ''),
        thinking: '',
        thinkingDuration: 0,
        model: '',
        usage: null,
        finishReason: '',
        totalDuration: 0,
        sources: []
    };
}

function normalizeAssistantText(rawText) {
    return String(rawText || '')
        .replace(/\r\n/g, '\n')
        .replace(/^\uFEFF/, '')
        .replace(/^\s+/, '');
}

function extractThinkingFromReply(rawText) {
    var text = normalizeAssistantText(rawText);
    if (!text) return { thinking: '', finalText: '' };

    var tags = [
        { start: '<think>', end: '</think>' },
        { start: '<analysis>', end: '</analysis>' },
        { start: '<reasoning>', end: '</reasoning>' }
    ];

    var lowerText = text.toLowerCase();

    for (var i = 0; i < tags.length; i++) {
        var startIdx = lowerText.indexOf(tags[i].start);
        if (startIdx !== -1) {
            // Find the *last* occurrence of the closing tag to prevent quoted tag cutoffs
            var endIdx = lowerText.lastIndexOf(tags[i].end);
            
            if (endIdx !== -1 && endIdx > startIdx) {
                // Completely closed thinking block
                var thinking = text.substring(startIdx + tags[i].start.length, endIdx).trim();
                var finalText = (text.substring(0, startIdx) + text.substring(endIdx + tags[i].end.length)).trim();
                return { thinking: thinking, finalText: finalText };
            } else {
                // Stream is still generating — everything after the start tag is thinking
                var thinkingLive = text.substring(startIdx + tags[i].start.length).trim();
                var finalTextLive = text.substring(0, startIdx).trim();
                return { thinking: thinkingLive, finalText: finalTextLive };
            }
        }
    }

    if (/^thinking process:/i.test(text) || /^thought for\s+\d/i.test(text)) {
        var parts = text.split(/\n\n+/);
        if (parts.length > 1) {
            var thinkPart = parts.shift().trim();
            var rest = parts.join('\n\n').trim();
            return { thinking: thinkPart, finalText: rest };
        }
    }

    return { thinking: '', finalText: text };
}

/* ───────────────────────────────────────────────
 *  INLINE MARKDOWN FORMATTING
 * ─────────────────────────────────────────────── */

/**
 * formatText: Renders inline markdown (bold, inline code, headers, line breaks).
 * Does NOT handle fenced code blocks — use formatAssistantBody for that.
 */
function formatText(rawText) {
    var text = Security.escapeHtml(rawText || '');
    text = text.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    text = text.replace(/\*(.+?)\*/g, '<strong>$1</strong>');
    text = text.replace(/(^|\n)\#\s(.+?)(?=\n|$)/g, '$1<span class="lead">$2</span>');
    
    // Web Search Citations: [1], [2], etc.
    text = text.replace(/\[(\d+)\]/g, '<a href="#source-index-$1" class="citation-pill" title="Jump to Source $1">$1</a>');
    
    text = text.replace(/\n/g, '<br>');
    return text;
}

function renderSourcesList(sources) {
    if (!sources || !sources.length) return '';
    var html = '<div class="sources-section">' +
        '<div class="sources-head"><i class="ri-global-line"></i> Sources</div>' +
        '<div class="sources-list">';
    
    for (var i = 0; i < sources.length; i++) {
        var s = sources[i];
        var idx = i + 1;
        html += '<a href="' + Security.escapeAttr(s.url) + '" target="_blank" class="source-item" id="source-index-' + idx + '" title="' + Security.escapeAttr(s.title) + '">' +
            '<div class="source-index">' + idx + '</div>' +
            '<i class="ri-links-line"></i>' +
            Security.escapeHtml(s.title || 'Source') +
            '</a>';
    }
    
    html += '</div></div>';
    return html;
}

/* ───────────────────────────────────────────────
 *  CODE BLOCK PARSING
 * ─────────────────────────────────────────────── */

/**
 * parseSegments: Splits raw text into text, code, math, and table segments.
 * Uses a two-pass approach:
 *   Pass 1: Extract markdown tables line-by-line (reliable, no complex regex).
 *   Pass 2: Run code/math regex on the remaining text chunks.
 */
function parseSegments(raw) {
    var source = String(raw || '');
    
    // ── Pass 1: Extract tables by line analysis ──
    var lines = source.split('\n');
    var chunks = [];       // { type: 'raw' | 'table', content: string }
    var tableBuffer = [];
    var textBuffer = [];
    
    function flushText() {
        if (textBuffer.length) {
            chunks.push({ type: 'raw', content: textBuffer.join('\n') });
            textBuffer = [];
        }
    }
    
    function flushTable() {
        if (tableBuffer.length >= 3) {
            chunks.push({ type: 'table', content: tableBuffer.join('\n') });
        } else if (tableBuffer.length) {
            // Not a valid table (fewer than 3 lines), treat as text
            textBuffer = textBuffer.concat(tableBuffer);
        }
        tableBuffer = [];
    }
    
    function isTableRow(line) {
        var trimmed = line.trim();
        return trimmed.length > 1 && trimmed.charAt(0) === '|' && trimmed.charAt(trimmed.length - 1) === '|';
    }
    
    function isSeparatorRow(line) {
        var trimmed = line.trim();
        if (trimmed.charAt(0) !== '|' || trimmed.charAt(trimmed.length - 1) !== '|') return false;
        // Strip leading/trailing pipes and check that remaining content is only dashes, colons, pipes, and spaces
        var inner = trimmed.slice(1, -1);
        return /^[\s|:\-]+$/.test(inner) && inner.indexOf('-') !== -1;
    }
    
    var inTable = false;
    
    for (var li = 0; li < lines.length; li++) {
        var line = lines[li];
        
        if (!inTable) {
            // Check if this line starts a table: must be a pipe row, AND the next line must be a separator
            if (isTableRow(line) && li + 1 < lines.length && isSeparatorRow(lines[li + 1])) {
                flushText();
                inTable = true;
                tableBuffer.push(line);
            } else {
                textBuffer.push(line);
            }
        } else {
            // We are inside a table
            if (isSeparatorRow(line) || isTableRow(line)) {
                tableBuffer.push(line);
            } else {
                // Table ended
                flushTable();
                inTable = false;
                textBuffer.push(line);
            }
        }
    }
    // Flush remaining buffers
    if (inTable) flushTable();
    flushText();
    
    // ── Pass 2: Run code/math regex on raw text chunks ──
    var segments = [];
    for (var ci = 0; ci < chunks.length; ci++) {
        if (chunks[ci].type === 'table') {
            segments.push({ type: 'table', content: chunks[ci].content });
        } else {
            // Parse code blocks and math from this raw text chunk
            var rawChunk = chunks[ci].content;
            var re = /(?:^[ \t]*```(?:([\w-]+)[ \t]*)?\r?\n([\s\S]*?)```)|(?:\\\[([\s\S]*?)\\\])|(?:\$\$([\s\S]*?)\$\$)|(?:\\\((.*?)\\\))|(?:(?<=\s|^)\$(.+?)\$(?=\s|$|[.,!?]))/gm;
            var last = 0;
            var m;
            while ((m = re.exec(rawChunk))) {
                if (m.index > last) segments.push({ type: 'text', content: rawChunk.slice(last, m.index) });
                
                if (m[2] !== undefined) {
                    segments.push({ type: 'code', lang: (m[1] || '').trim().toLowerCase(), content: m[2] });
                } else if (m[3] !== undefined) {
                    segments.push({ type: 'math-block', content: '\\[' + m[3] + '\\]' });
                } else if (m[4] !== undefined) {
                    segments.push({ type: 'math-block', content: '$$' + m[4] + '$$' });
                } else if (m[5] !== undefined) {
                    segments.push({ type: 'math-inline', content: '\\(' + m[5] + '\\)' });
                } else if (m[6] !== undefined) {
                    segments.push({ type: 'math-inline', content: '$' + m[6] + '$' });
                }
                
                last = re.lastIndex;
            }
            if (last < rawChunk.length) segments.push({ type: 'text', content: rawChunk.slice(last) });
        }
    }
    
    return segments.filter(function (seg) { return seg.content !== ''; });
}

function renderMarkdownTable(rawTable) {
    var lines = rawTable.trim().split('\n');
    if (lines.length < 2) return '';

    function getCells(line) {
        return line.trim().replace(/^\||\|$/g, '').split('|').map(function(c) { return c.trim(); });
    }

    var headerCells = getCells(lines[0]);
    var alignLineCells = getCells(lines[1]);
    var align = alignLineCells.map(function(c) {
        if (c.startsWith(':') && c.endsWith(':')) return 'center';
        if (c.endsWith(':')) return 'right';
        return 'left';
    });

    var html = '<div class="table-wrapper"><table class="markdown-table"><thead><tr>';
    for (var i = 0; i < headerCells.length; i++) {
        var style = align[i] ? ' style="text-align:' + align[i] + ';"' : '';
        html += '<th' + style + '>' + formatText(headerCells[i]) + '</th>';
    }
    html += '</tr></thead><tbody>';

    for (var j = 2; j < lines.length; j++) {
        var rowCells = getCells(lines[j]);
        html += '<tr>';
        for (var k = 0; k < headerCells.length; k++) {
            var cellStyle = align[k] ? ' style="text-align:' + align[k] + ';"' : '';
            html += '<td' + cellStyle + '>' + formatText(rowCells[k] || '') + '</td>';
        }
        html += '</tr>';
    }

    html += '</tbody></table></div>';
    return html;
}

/* ───────────────────────────────────────────────
 *  SYNTAX HIGHLIGHTING
 * ─────────────────────────────────────────────── */
function highlightCode(code, lang) {
    var html = Security.escapeHtml(code);
    var l = (lang || '').toLowerCase();

    if (l === 'html' || l === 'xml' || l === 'svg') {
        html = html.replace(/(&#060;!--[\s\S]*?--&#062;)/g, '<span class="tok-comment">$1</span>');
        html = html.replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="tok-comment">$1</span>');
        html = html.replace(/\b(class|id|href|src|style|alt|title|type|name|value|for|role|data-[a-zA-Z0-9-]*|aria-[a-zA-Z0-9-]*)(=)/g, ' <span class="tok-attr">$1</span>$2');
        html = html.replace(/(&quot;.*?&quot;|&#039;.*?&#039;)/g, '<span class="tok-string">$1</span>');
        return html;
    }

    if (l === 'css') {
        html = html.replace(/\/\*[\s\S]*?\*\//g, '<span class="tok-comment">$&</span>');
        html = html.replace(/(&quot;.*?&quot;|&#039;.*?&#039;)/g, '<span class="tok-string">$1</span>');
        html = html.replace(/([\w-]+)(\s*:)/g, '<span class="tok-prop">$1</span>$2');
        html = html.replace(/\b([0-9]+(?:\.[0-9]+)?)(px|rem|em|vh|vw|%|s|ms)?\b/g, '<span class="tok-number">$1$2</span>');
        return html;
    }

    html = html.replace(/\/\/.*$/gm, '<span class="tok-comment">$&</span>');
    html = html.replace(/\/\*[\s\S]*?\*\//g, '<span class="tok-comment">$&</span>');
    html = html.replace(/(&quot;.*?&quot;|&#039;.*?&#039;|`.*?`)/g, '<span class="tok-string">$1</span>');
    html = html.replace(/\b(\d+(?:\.\d+)?)\b/g, '<span class="tok-number">$1</span>');
    html = html.replace(/\b(const|let|var|function|return|if|else|for|while|switch|case|break|continue|class|new|try|catch|finally|async|await|throw|import|from|export|default|extends|super|this|true|false|null|undefined)\b/g, '<span class="tok-keyword">$1</span>');
    return html;
}

/* ───────────────────────────────────────────────
 *  ASSISTANT BODY RENDERING (code blocks)
 * ─────────────────────────────────────────────── */

/**
 * formatAssistantBody: Handles BOTH text and code blocks properly.
 * Uses the copy registry instead of data-code attributes for safer copy.
 */
function formatAssistantBody(rawText) {
    var segments = parseSegments(rawText);
    if (!segments.length) return '<div class="message-text"></div>';
    var htmlContent = segments.map(function (seg) {
        if (seg.type === 'text') return '<div class="message-text">' + formatText(seg.content) + '</div>';
        if (seg.type === 'table') return renderMarkdownTable(seg.content);
        if (seg.type === 'math-block') return '<div class="math-block">' + Security.escapeHtml(seg.content) + '</div>';
        if (seg.type === 'math-inline') return '<span class="math-inline">' + Security.escapeHtml(seg.content) + '</span>';
        
        var langLabel = seg.lang ? seg.lang : 'code';
        var highlighted = highlightCode(seg.content, seg.lang);
        // Register code in copy registry instead of using data-code attribute (fixes M5)
        var copyId = AppState._copyRegistry.length;
        AppState._copyRegistry.push(seg.content);
        return '<div class="code-block" data-copy-id="' + copyId + '">' +
            '<div class="code-head">' +
            '<span class="code-lang">' + Security.escapeHtml(langLabel) + '</span>' +
            '<button class="code-copy-btn" title="Copy code" data-action="copy-code" data-copy-id="' + copyId + '">' +
            '<i class="ri-file-copy-line"></i> Copy</button>' +
            '</div>' +
            '<pre><code class="code-content">' + highlighted + '</code></pre>' +
            '</div>';
    }).join('');
    
    // Trigger MathJax typesetting if available
    if (window.MathJax && window.MathJax.typesetPromise) {
        setTimeout(function() {
            window.MathJax.typesetPromise().catch(function(err) { console.log('MathJax error:', err); });
        }, 10);
    }
    
    return htmlContent;
}

/**
 * formatLiveStreamingBody: Used during live streaming to show content.
 */
function formatLiveStreamingBody(rawText) {
    var text = String(rawText || '');
    var hasCompleteCodeBlock = /```[\w-]*\s*\r?\n[\s\S]*?```/.test(text);
    var hasIncompleteCodeFence = /```[\w-]*\s*\r?\n[^`]*$/.test(text);

    if (hasCompleteCodeBlock) {
        if (hasIncompleteCodeFence) {
            var segments = parseSegments(text);
            var result = '';
            for (var i = 0; i < segments.length; i++) {
                var seg = segments[i];
                if (seg.type === 'text') {
                    var incompleteFenceMatch = seg.content.match(/```[\w-]*\s*\r?\n([\s\S]*)$/);
                    if (incompleteFenceMatch) {
                        var beforeFence = seg.content.slice(0, incompleteFenceMatch.index);
                        var streamingCode = incompleteFenceMatch[1] || '';
                        if (beforeFence.trim()) {
                            result += '<div class="message-text">' + formatText(beforeFence) + '</div>';
                        }
                        var langMatch = seg.content.match(/```([\w-]+)/);
                        var streamLang = langMatch ? langMatch[1] : 'code';
                        result += '<div class="code-block">' +
                            '<div class="code-head">' +
                            '<span class="code-lang">' + Security.escapeHtml(streamLang) + '</span>' +
                            '<span class="streaming-indicator">streaming…</span>' +
                            '</div>' +
                            '<pre><code class="code-content">' + highlightCode(streamingCode, streamLang) + '</code></pre>' +
                            '</div>';
                    } else {
                        result += '<div class="message-text">' + formatText(seg.content) + '</div>';
                    }
                } else if (seg.type === 'table') {
                    result += renderMarkdownTable(seg.content);
                } else if (seg.type === 'math-block') {
                    result += '<div class="math-block">' + Security.escapeHtml(seg.content) + '</div>';
                } else if (seg.type === 'math-inline') {
                    result += '<span class="math-inline">' + Security.escapeHtml(seg.content) + '</span>';
                } else {
                    var langLabel2 = seg.lang ? seg.lang : 'code';
                    var highlighted2 = highlightCode(seg.content, seg.lang);
                    var copyId2 = AppState._copyRegistry.length;
                    AppState._copyRegistry.push(seg.content);
                    result += '<div class="code-block" data-copy-id="' + copyId2 + '">' +
                        '<div class="code-head">' +
                        '<span class="code-lang">' + Security.escapeHtml(langLabel2) + '</span>' +
                        '<button class="code-copy-btn" title="Copy code" data-action="copy-code" data-copy-id="' + copyId2 + '">' +
                        '<i class="ri-file-copy-line"></i> Copy</button>' +
                        '</div>' +
                        '<pre><code class="code-content">' + highlighted2 + '</code></pre>' +
                        '</div>';
                }
            }
            
            // Trigger MathJax typesetting if available
            if (window.MathJax && window.MathJax.typesetPromise) {
                setTimeout(function() {
                    window.MathJax.typesetPromise().catch(function(err) { console.log('MathJax error:', err); });
                }, 10);
            }
            
            return result;
        }
        return formatAssistantBody(text);
    }

    if (hasIncompleteCodeFence) {
        var fenceMatch = text.match(/([\s\S]*?)```([\w-]*)\s*\r?\n([\s\S]*)$/);
        if (fenceMatch) {
            var beforeFence2 = fenceMatch[1] || '';
            var streamLang2 = fenceMatch[2] || 'code';
            var streamingCode2 = fenceMatch[3] || '';
            var result2 = '';
            if (beforeFence2.trim()) {
                result2 += '<div class="message-text">' + formatText(beforeFence2) + '</div>';
            }
            result2 += '<div class="code-block">' +
                '<div class="code-head">' +
                '<span class="code-lang">' + Security.escapeHtml(streamLang2) + '</span>' +
                '<span class="streaming-indicator">streaming…</span>' +
                '</div>' +
                '<pre><code class="code-content">' + highlightCode(streamingCode2, streamLang2) + '</code></pre>' +
                '</div>';
            
            // Trigger MathJax typesetting if available
            if (window.MathJax && window.MathJax.typesetPromise) {
                setTimeout(function() {
                    window.MathJax.typesetPromise().catch(function(err) { console.log('MathJax error:', err); });
                }, 10);
            }
            
            return result2;
        }
    }
    // Check if text contains a markdown table (pipe-rows with a separator)
    // If so, use the full formatAssistantBody which calls parseSegments
    if (/^\s*\|.*\|/m.test(text) && /^\s*\|[\s:\-|]+\|/m.test(text)) {
        return formatAssistantBody(text);
    }

    var result3 = '<div class="message-text">' + formatText(text) + '</div>';
    
    // Trigger MathJax typesetting if available
    if (window.MathJax && window.MathJax.typesetPromise) {
        setTimeout(function() {
            window.MathJax.typesetPromise().catch(function(err) { console.log('MathJax error:', err); });
        }, 10);
    }
    
    return result3;
}

/* ───────────────────────────────────────────────
 *  RESPONSE PARSING
 * ─────────────────────────────────────────────── */
function extractAssistantReply(responseData) {
    var candidates = [
        responseData && responseData.choices && responseData.choices[0] && responseData.choices[0].message && responseData.choices[0].message.content,
        responseData && responseData.choices && responseData.choices[0] && responseData.choices[0].delta && responseData.choices[0].delta.content,
        responseData && responseData.choices && responseData.choices[0] && responseData.choices[0].text,
        responseData && responseData.message && responseData.message.content,
        responseData && responseData.content,
        responseData && responseData.response,
        responseData && responseData.output_text,
        responseData && responseData.text,
        responseData && responseData.reply,
        responseData && responseData.completion
    ];

    for (var i = 0; i < candidates.length; i++) {
        var item = candidates[i];
        if (Array.isArray(item)) {
            var joined = item.map(function (part) {
                if (typeof part === 'string') return part;
                return (part && (part.text != null ? part.text : (part.content != null ? part.content : ''))) || '';
            }).join('');
            if (joined.trim()) return normalizeAssistantText(joined);
        } else if (typeof item === 'string' && item.trim()) {
            return normalizeAssistantText(item);
        }
    }

    if (typeof responseData === 'string' && responseData.trim()) {
        return normalizeAssistantText(responseData);
    }

    return '';
}

function parseStreamedAssistantReply(rawText) {
    var lines = String(rawText || '').split(/\r?\n/);
    var output = '';
    for (var i = 0; i < lines.length; i++) {
        var trimmed = lines[i].trim();
        if (trimmed.indexOf('data:') !== 0) continue;
        var payload = trimmed.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
            var obj = Security.safeJsonParse(payload);
            var chunk =
                (obj && obj.choices && obj.choices[0] && obj.choices[0].delta && obj.choices[0].delta.content != null)
                    ? obj.choices[0].delta.content
                    : (obj && obj.choices && obj.choices[0] && obj.choices[0].message && obj.choices[0].message.content != null)
                        ? obj.choices[0].message.content
                        : (obj && obj.choices && obj.choices[0] && obj.choices[0].text != null)
                            ? obj.choices[0].text
                            : (obj && obj.content != null)
                                ? obj.content
                                : '';
            if (typeof chunk === 'string') output += chunk;
            else if (Array.isArray(chunk)) {
                output += chunk.map(function (part) {
                    return (part && (part.text != null ? part.text : (part.content != null ? part.content : ''))) || '';
                }).join('');
            }
        } catch (_e) { }
    }
    return normalizeAssistantText(output);
}

function readResponsePayload(response) {
    return response.text().then(function (raw) {
        if (!raw) return {};
        try {
            return Security.safeJsonParse(raw);
        } catch (_e) {
            var streamed = parseStreamedAssistantReply(raw);
            return streamed ? { content: streamed } : { content: raw };
        }
    });
}

/* ───────────────────────────────────────────────
 *  SMART TITLE
 * ─────────────────────────────────────────────── */
function makeSmartTitle(firstMessage) {
    var text = (firstMessage || '').trim();
    if (!text) return 'New Chat';
    var normalized = text.toLowerCase();
    if (/^(hi|hello|hey|good morning|good afternoon|good evening)\b/.test(normalized)) return 'Greeting by User';
    if (normalized.indexOf('help') !== -1) return 'Help Request';
    if (normalized.indexOf('idea') !== -1) return 'Idea Discussion';
    if (normalized.indexOf('code') !== -1 || normalized.indexOf('website') !== -1 || normalized.indexOf('html') !== -1) return 'Coding Chat';
    return Security.validateChatTitle(text.slice(0, 28).replace(/\s+/g, ' '));
}
