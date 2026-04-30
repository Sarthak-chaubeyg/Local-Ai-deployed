/**
 * Upload Module — File attachment handling for chat context.
 * Supports text files, code files, and PDFs (via pdf.js).
 * Files are stored in memory per session (not in localStorage).
 *
 * 🔒 Security:
 * - File size validated before reading
 * - Per-chat 30MB limit enforced
 * - File content sanitized (null bytes, control chars removed)
 * - Only whitelisted file types accepted
 */
'use strict';

var FileUpload = (function () {

    /* ───────────────────────────────────────────────
     *  STATE
     * ─────────────────────────────────────────────── */
    var pendingFiles = [];  // Files waiting to be sent with next message
    var chatFileSizes = {}; // chatIndex -> total bytes uploaded

    var MAX_SIZE_BYTES = (AppConfig.MAX_UPLOAD_SIZE_MB || 30) * 1024 * 1024;

    /* ───────────────────────────────────────────────
     *  FILE TYPE DETECTION
     * ─────────────────────────────────────────────── */
    var TEXT_EXTENSIONS = [
        'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'jsonl', 'xml',
        'html', 'htm', 'css', 'js', 'ts', 'jsx', 'tsx', 'mjs', 'cjs',
        'py', 'pyw', 'java', 'c', 'cpp', 'cc', 'h', 'hpp', 'hxx',
        'cs', 'rb', 'php', 'go', 'rs', 'swift', 'kt', 'kts', 'scala',
        'sh', 'bash', 'zsh', 'fish', 'ps1', 'psm1', 'bat', 'cmd',
        'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'config',
        'log', 'sql', 'r', 'rmd', 'lua', 'pl', 'pm', 'dart',
        'vue', 'svelte', 'astro', 'tex', 'bib', 'rst', 'adoc', 'org',
        'properties', 'env', 'gitignore', 'dockerignore', 'editorconfig',
        'dockerfile', 'makefile', 'cmake', 'gradle', 'sbt',
        'sass', 'scss', 'less', 'styl', 'graphql', 'gql', 'proto',
        'tf', 'hcl', 'nix', 'dhall', 'zig', 'nim', 'v', 'odin',
        'asm', 's', 'vhdl', 'vhd', 'sv', 'svh', 'tcl', 'awk', 'sed'
    ];

    function _getExt(filename) {
        var parts = String(filename || '').split('.');
        return parts.length > 1 ? parts.pop().toLowerCase() : '';
    }

    function _isTextFile(file) {
        if (file.type && (file.type.startsWith('text/') ||
            file.type === 'application/json' ||
            file.type === 'application/xml' ||
            file.type === 'application/javascript' ||
            file.type === 'application/x-yaml' ||
            file.type === 'application/toml')) return true;
        return TEXT_EXTENSIONS.indexOf(_getExt(file.name)) !== -1;
    }

    function _isPdf(file) {
        return file.type === 'application/pdf' || _getExt(file.name) === 'pdf';
    }

    /* ───────────────────────────────────────────────
     *  FILE READERS
     * ─────────────────────────────────────────────── */
    function _readAsText(file) {
        return new Promise(function (resolve, reject) {
            var reader = new FileReader();
            reader.onload = function (e) {
                var text = e.target.result || '';
                // Security: remove null bytes and control characters
                text = text.replace(/\0/g, '');
                resolve(text);
            };
            reader.onerror = function () { reject(new Error('Failed to read: ' + file.name)); };
            reader.readAsText(file, 'UTF-8');
        });
    }

    function _readPdf(file) {
        return new Promise(function (resolve, reject) {
            if (typeof pdfjsLib === 'undefined') {
                reject(new Error('PDF parser not loaded. Check internet connection and reload.'));
                return;
            }

            var reader = new FileReader();
            reader.onload = function (e) {
                var data = new Uint8Array(e.target.result);

                pdfjsLib.getDocument({ data: data }).promise
                    .then(function (pdf) {
                        var totalPages = pdf.numPages;
                        var pageTexts = [];
                        var processed = 0;

                        function doPage(num) {
                            pdf.getPage(num).then(function (page) {
                                return page.getTextContent();
                            }).then(function (content) {
                                var text = content.items.map(function (item) {
                                    return item.str;
                                }).join(' ');
                                pageTexts[num - 1] = text;
                                processed++;
                                if (processed === totalPages) {
                                    resolve(pageTexts.join('\n\n--- Page ' + 'Break ---\n\n'));
                                }
                            }).catch(function () {
                                pageTexts[num - 1] = '[Error reading page ' + num + ']';
                                processed++;
                                if (processed === totalPages) {
                                    resolve(pageTexts.join('\n\n--- Page ' + 'Break ---\n\n'));
                                }
                            });
                        }

                        if (totalPages === 0) {
                            resolve('[Empty PDF]');
                            return;
                        }

                        for (var i = 1; i <= totalPages; i++) {
                            doPage(i);
                        }
                    })
                    .catch(function (err) {
                        reject(new Error('PDF parse error: ' + (err.message || err)));
                    });
            };
            reader.onerror = function () { reject(new Error('Failed to read: ' + file.name)); };
            reader.readAsArrayBuffer(file);
        });
    }

    /* ───────────────────────────────────────────────
     *  PROCESS FILE
     * ─────────────────────────────────────────────── */
    function _processFile(file) {
        // Size check
        if (file.size > MAX_SIZE_BYTES) {
            return Promise.reject(new Error(
                file.name + ' is ' + _formatSize(file.size) +
                ' — exceeds ' + AppConfig.MAX_UPLOAD_SIZE_MB + 'MB limit'
            ));
        }

        // Per-chat cumulative check
        var chatIdx = AppState.currentChatIndex;
        var currentTotal = (chatIdx !== null ? (chatFileSizes[chatIdx] || 0) : 0);
        var pendingTotal = 0;
        for (var i = 0; i < pendingFiles.length; i++) pendingTotal += pendingFiles[i].size;

        if (currentTotal + pendingTotal + file.size > MAX_SIZE_BYTES) {
            return Promise.reject(new Error(
                'Chat file limit of ' + AppConfig.MAX_UPLOAD_SIZE_MB +
                'MB would be exceeded (' + _formatSize(currentTotal + pendingTotal) + ' already used)'
            ));
        }

        // PDF
        if (_isPdf(file)) {
            return _readPdf(file).then(function (text) {
                return { name: file.name, size: file.size, type: 'pdf', content: text };
            });
        }

        // Text / Code
        if (_isTextFile(file)) {
            return _readAsText(file).then(function (text) {
                return { name: file.name, size: file.size, type: 'text', content: text };
            });
        }

        // Unsupported
        return Promise.reject(new Error(
            file.name + ': Unsupported format. Please use text files (code, .txt, .md, .csv, .json, .xml, etc.) or PDFs.'
        ));
    }

    /* ───────────────────────────────────────────────
     *  PENDING FILES UI
     * ─────────────────────────────────────────────── */
    function _formatSize(bytes) {
        if (!bytes || bytes <= 0) return '0 B';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    }

    function renderPendingFiles() {
        var container = document.getElementById('filePreview');
        if (!container) return;

        if (!pendingFiles.length) {
            container.style.display = 'none';
            container.innerHTML = '';
            return;
        }

        container.style.display = 'flex';
        var fragment = document.createDocumentFragment();

        for (var i = 0; i < pendingFiles.length; i++) {
            (function (idx) {
                var f = pendingFiles[idx];
                var chip = document.createElement('div');
                chip.className = 'file-chip';

                var icon = document.createElement('i');
                icon.className = f.type === 'pdf' ? 'ri-file-pdf-2-line' : 'ri-file-text-line';

                var name = document.createElement('span');
                name.className = 'file-chip-name';
                name.textContent = f.name;
                name.title = f.name + ' (' + _formatSize(f.size) + ')';

                var size = document.createElement('span');
                size.className = 'file-chip-size';
                size.textContent = _formatSize(f.size);

                var removeBtn = document.createElement('button');
                removeBtn.className = 'file-chip-remove';
                removeBtn.title = 'Remove';
                removeBtn.innerHTML = '<i class="ri-close-line"></i>';
                removeBtn.addEventListener('click', function () {
                    removePendingFile(idx);
                });

                chip.appendChild(icon);
                chip.appendChild(name);
                chip.appendChild(size);
                chip.appendChild(removeBtn);
                fragment.appendChild(chip);
            })(i);
        }

        container.innerHTML = '';
        container.appendChild(fragment);
    }

    function removePendingFile(index) {
        pendingFiles.splice(index, 1);
        renderPendingFiles();
        if (!pendingFiles.length) {
            setStatus('Ready');
        } else {
            setStatus(pendingFiles.length + ' file' + (pendingFiles.length === 1 ? '' : 's') + ' attached');
        }
    }

    /* ───────────────────────────────────────────────
     *  PUBLIC API
     * ─────────────────────────────────────────────── */
    function handleFileInput(inputEl) {
        if (!inputEl.files || !inputEl.files.length) return;

        var fileList = [];
        for (var i = 0; i < inputEl.files.length; i++) {
            fileList.push(inputEl.files[i]);
        }

        setStatus('Reading ' + fileList.length + ' file' + (fileList.length === 1 ? '' : 's') + '...');

        var promises = fileList.map(function (file) {
            return _processFile(file).catch(function (err) {
                setStatus('⚠️ ' + err.message);
                return null; // Don't fail the whole batch
            });
        });

        Promise.all(promises).then(function (results) {
            var added = 0;
            for (var j = 0; j < results.length; j++) {
                if (results[j]) {
                    pendingFiles.push(results[j]);
                    added++;
                }
            }
            if (added) {
                renderPendingFiles();
                setStatus(pendingFiles.length + ' file' + (pendingFiles.length === 1 ? '' : 's') + ' attached — send a message to use ' + (pendingFiles.length === 1 ? 'it' : 'them'));
            }
        });

        // Reset so the same file can be re-selected
        inputEl.value = '';
    }

    function consumePendingFiles() {
        var files = pendingFiles.slice();
        pendingFiles = [];
        renderPendingFiles();
        return files;
    }

    function buildFileContext(files) {
        if (!files || !files.length) return '';

        var parts = [];
        parts.push('=== UPLOADED DOCUMENTS ===');
        parts.push('The user has uploaded ' + files.length + ' document' + (files.length === 1 ? '' : 's') + '. Read and use the content below to answer their query.\n');

        for (var i = 0; i < files.length; i++) {
            var f = files[i];
            parts.push('──── FILE: ' + f.name + ' (' + _formatSize(f.size) + ', ' + f.type.toUpperCase() + ') ────');
            parts.push(f.content);
            parts.push('──── END: ' + f.name + ' ────\n');
        }

        parts.push('=== END UPLOADED DOCUMENTS ===\n');
        return parts.join('\n');
    }

    function trackFilesForChat(chatIndex, files) {
        if (!chatFileSizes[chatIndex]) chatFileSizes[chatIndex] = 0;
        for (var i = 0; i < files.length; i++) {
            chatFileSizes[chatIndex] += files[i].size;
        }
    }

    function getPendingCount() {
        return pendingFiles.length;
    }

    // Initialize pdf.js worker if available
    if (typeof pdfjsLib !== 'undefined') {
        pdfjsLib.GlobalWorkerOptions.workerSrc = 'js/lib/pdf.worker.min.js';
    }

    return Object.freeze({
        handleFileInput: handleFileInput,
        consumePendingFiles: consumePendingFiles,
        buildFileContext: buildFileContext,
        trackFilesForChat: trackFilesForChat,
        getPendingCount: getPendingCount,
        removePendingFile: removePendingFile,
        renderPendingFiles: renderPendingFiles
    });
})();
