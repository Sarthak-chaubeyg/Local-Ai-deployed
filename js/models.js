/**
 * Models Module — Model Manager modal (load/unload).
 * Handles the Model Manager overlay with load/unload controls.
 * All model names and values are escaped through Security module.
 * Event delegation used instead of inline onclick handlers (fixes H6).
 */
'use strict';

/* ───────────────────────────────────────────────
 *  UTILITY
 * ─────────────────────────────────────────────── */
function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '—';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(1) + ' GB';
}

function showToast(message, type, durationMs) {
    type = type || 'info';
    durationMs = durationMs || 3500;
    var toast = document.getElementById('mmToast');
    if (!toast) return;
    toast.textContent = message;
    toast.className = 'mm-toast ' + type;
    if (AppState._toastTimer) clearTimeout(AppState._toastTimer);
    void toast.offsetWidth; // Force reflow for animation
    toast.classList.add('visible');
    AppState._toastTimer = setTimeout(function () {
        toast.classList.remove('visible');
    }, durationMs);
}

/* ───────────────────────────────────────────────
 *  API CALLS
 * ─────────────────────────────────────────────── */
function fetchAllDownloadedModels() {
    var url = AppState.currentBaseUrl + AppConfig.MODEL_LIST_V1_ENDPOINT;
    return Security.fetchJsonWithTimeout(url, {
        method: 'GET',
        headers: Security.getAuthHeaders(),
        credentials: 'omit',
        cache: 'no-store'
    }, 8000)
    .then(function (data) {
        var modelList = (data && Array.isArray(data.models)) ? data.models : [];
        return modelList.filter(function (m) {
            var t = String(m && m.type || '').toLowerCase();
            return t === 'llm' || t === 'vlm';
        });
    })
    .catch(function (err) {
        console.error('Failed to fetch all models:', err);
        return [];
    });
}

function loadModelApi(modelKey) {
    var url = AppState.currentBaseUrl + AppConfig.MODEL_LOAD_ENDPOINT;
    return fetch(url, {
        method: 'POST',
        headers: Security.getAuthHeaders(),
        credentials: 'omit',
        body: JSON.stringify({
            model: modelKey,
            echo_load_config: true
        })
    }).then(function (response) {
        if (!response.ok) {
            return response.text().catch(function () { return ''; }).then(function (text) {
                throw new Error('Load failed: HTTP ' + response.status + (text ? ' — ' + text.slice(0, 200) : ''));
            });
        }
        return response.json();
    });
}

function unloadModelApi(instanceId) {
    var url = AppState.currentBaseUrl + AppConfig.MODEL_UNLOAD_ENDPOINT;
    return fetch(url, {
        method: 'POST',
        headers: Security.getAuthHeaders(),
        credentials: 'omit',
        body: JSON.stringify({
            instance_id: instanceId
        })
    }).then(function (response) {
        if (!response.ok) {
            return response.text().catch(function () { return ''; }).then(function (text) {
                throw new Error('Unload failed: HTTP ' + response.status + (text ? ' — ' + text.slice(0, 200) : ''));
            });
        }
        return response.json();
    });
}

/* ───────────────────────────────────────────────
 *  LOAD / UNLOAD HANDLERS
 * ─────────────────────────────────────────────── */
function handleLoadModel(modelKey) {
    if (AppState.mmBusy.has(modelKey)) return;
    AppState.mmBusy.add(modelKey);
    renderModelManagerCards();

    loadModelApi(modelKey)
        .then(function (result) {
            showToast('✅ Loaded ' + modelKey + ' in ' + ((result && result.load_time_seconds) || 0).toFixed(1) + 's', 'success');
            return refreshAfterModelChange();
        })
        .catch(function (err) {
            console.error('Load error:', err);
            showToast('❌ Failed to load: ' + err.message, 'error', 5000);
        })
        .then(function () {
            AppState.mmBusy.delete(modelKey);
            renderModelManagerCards();
        });
}

function handleUnloadModel(modelKey, instanceId) {
    if (AppState.mmBusy.has(modelKey)) return;
    AppState.mmBusy.add(modelKey);
    renderModelManagerCards();

    unloadModelApi(instanceId)
        .then(function () {
            showToast('✅ Unloaded ' + modelKey, 'success');
            return refreshAfterModelChange();
        })
        .catch(function (err) {
            console.error('Unload error:', err);
            showToast('❌ Failed to unload: ' + err.message, 'error', 5000);
        })
        .then(function () {
            AppState.mmBusy.delete(modelKey);
            renderModelManagerCards();
        });
}

function refreshAfterModelChange() {
    return fetchAllDownloadedModels().then(function (models) {
        AppState.allDownloadedModels = models;
        renderModelManagerCards();

        var loaded = models
            .filter(function (m) { return m.loaded_instances && m.loaded_instances.length > 0; })
            .map(function (m) { return String(m.key || m.id || '').trim(); })
            .filter(Boolean);

        AppState.models = loaded;
        if (AppState.models.indexOf(AppState.selectedModel) === -1) {
            AppState.selectedModel = AppState.models[0] || '';
        }
        saveModelSelection();
        renderModelSelect();
        updateHeader();
        syncThinkingAvailability();

        var modelCount = document.getElementById('modelCount');
        if (modelCount) {
            modelCount.textContent = AppState.models.length
                ? AppState.models.length + ' running model' + (AppState.models.length === 1 ? '' : 's') + ' found'
                : 'No running models found';
        }
    });
}

/* ───────────────────────────────────────────────
 *  CARD RENDERING (event delegation — fixes H6)
 * ─────────────────────────────────────────────── */
function renderModelManagerCards() {
    var body = document.getElementById('mmBody');
    if (!body) return;

    if (!AppState.allDownloadedModels.length) {
        body.innerHTML = '<div class="mm-empty">' +
            '<i class="ri-inbox-2-line"></i>' +
            'No downloaded models found.<br>' +
            '<span class="mm-empty-hint">Make sure LM Studio is running and the API server is started.</span>' +
            '</div>';
        return;
    }

    var sorted = AppState.allDownloadedModels.slice().sort(function (a, b) {
        var aLoaded = (a.loaded_instances && a.loaded_instances.length > 0) ? 0 : 1;
        var bLoaded = (b.loaded_instances && b.loaded_instances.length > 0) ? 0 : 1;
        if (aLoaded !== bLoaded) return aLoaded - bLoaded;
        return (a.display_name || a.key || '').localeCompare(b.display_name || b.key || '');
    });

    var loadedModels = sorted.filter(function (m) { return m.loaded_instances && m.loaded_instances.length > 0; });
    var unloadedModels = sorted.filter(function (m) { return !m.loaded_instances || !m.loaded_instances.length; });

    // Build DOM instead of innerHTML for model cards (safer)
    var fragment = document.createDocumentFragment();

    if (loadedModels.length) {
        var labelLoaded = document.createElement('div');
        labelLoaded.className = 'mm-section-label';
        labelLoaded.textContent = 'Loaded (' + loadedModels.length + ')';
        fragment.appendChild(labelLoaded);
        for (var i = 0; i < loadedModels.length; i++) {
            fragment.appendChild(_buildModelCardDOM(loadedModels[i]));
        }
    }

    if (unloadedModels.length) {
        var labelAvail = document.createElement('div');
        labelAvail.className = 'mm-section-label';
        labelAvail.textContent = 'Available (' + unloadedModels.length + ')';
        fragment.appendChild(labelAvail);
        for (var j = 0; j < unloadedModels.length; j++) {
            fragment.appendChild(_buildModelCardDOM(unloadedModels[j]));
        }
    }

    body.innerHTML = '';
    body.appendChild(fragment);
}

/**
 * Build a model card as a DOM element (not innerHTML string).
 * This completely eliminates the inline onclick XSS vector (fixes H6).
 */
function _buildModelCardDOM(model) {
    var key = model.key || model.id || '';
    var name = model.display_name || key;
    var publisher = model.publisher || '';
    var size = formatFileSize(model.size_bytes);
    var quant = (model.quantization && model.quantization.name) || '';
    var params = model.params_string || '';
    var format = model.format || '';
    var isLoaded = model.loaded_instances && model.loaded_instances.length > 0;
    var instanceId = isLoaded ? (model.loaded_instances[0].id || key) : '';
    var isBusy = AppState.mmBusy.has(key);

    var card = document.createElement('div');
    card.className = 'mm-card' + (isLoaded ? ' is-loaded' : '');

    // Icon
    var iconDiv = document.createElement('div');
    iconDiv.className = 'mm-card-icon';
    var icon = document.createElement('i');
    icon.className = isLoaded ? 'ri-checkbox-circle-fill' : 'ri-cpu-line';
    iconDiv.appendChild(icon);

    // Info
    var infoDiv = document.createElement('div');
    infoDiv.className = 'mm-card-info';

    var nameDiv = document.createElement('div');
    nameDiv.className = 'mm-card-name';
    nameDiv.title = key;
    nameDiv.textContent = name; // textContent = safe, no XSS

    var metaDiv = document.createElement('div');
    metaDiv.className = 'mm-card-meta';
    var metaItems = [];
    if (publisher) metaItems.push(publisher);
    if (params) metaItems.push(params);
    if (quant) metaItems.push(quant);
    if (size !== '—') metaItems.push(size);
    if (format) metaItems.push(format.toUpperCase());
    if (isLoaded) metaItems.push('● Loaded');

    for (var k = 0; k < metaItems.length; k++) {
        var chip = document.createElement('span');
        chip.className = 'mm-chip' + (k === metaItems.length - 1 && isLoaded ? ' loaded-badge' : '');
        chip.textContent = metaItems[k]; // textContent = safe
        metaDiv.appendChild(chip);
    }

    infoDiv.appendChild(nameDiv);
    infoDiv.appendChild(metaDiv);

    // Actions
    var actionsDiv = document.createElement('div');
    actionsDiv.className = 'mm-card-actions';

    if (isBusy) {
        var busyBtn = document.createElement('button');
        busyBtn.className = isLoaded ? 'mm-unload-btn' : 'mm-load-btn';
        busyBtn.disabled = true;
        busyBtn.innerHTML = '<span class="mm-btn-spinner"></span> ' + (isLoaded ? 'Unloading…' : 'Loading…');
        actionsDiv.appendChild(busyBtn);
    } else if (isLoaded) {
        var unloadBtn = document.createElement('button');
        unloadBtn.className = 'mm-unload-btn';
        unloadBtn.innerHTML = '<i class="ri-eject-line"></i> Unload';
        // Safe event listener — no inline JS with user data
        (function (k, iid) {
            unloadBtn.addEventListener('click', function () { handleUnloadModel(k, iid); });
        })(key, instanceId);
        actionsDiv.appendChild(unloadBtn);
    } else {
        var loadBtn = document.createElement('button');
        loadBtn.className = 'mm-load-btn';
        loadBtn.innerHTML = '<i class="ri-play-circle-line"></i> Load';
        // Safe event listener — no inline JS with user data
        (function (k) {
            loadBtn.addEventListener('click', function () { handleLoadModel(k); });
        })(key);
        actionsDiv.appendChild(loadBtn);
    }

    card.appendChild(iconDiv);
    card.appendChild(infoDiv);
    card.appendChild(actionsDiv);

    return card;
}

/* ───────────────────────────────────────────────
 *  MODAL OPEN / CLOSE
 * ─────────────────────────────────────────────── */
function openModelManager() {
    var overlay = document.getElementById('modelManagerOverlay');
    var body = document.getElementById('mmBody');
    overlay.style.display = 'flex';
    void overlay.offsetWidth;
    overlay.classList.add('visible');

    body.innerHTML = '<div class="mm-loading"><i class="ri-loader-4-line"></i>Loading model list...</div>';

    fetchAllDownloadedModels().then(function (models) {
        AppState.allDownloadedModels = models;
        renderModelManagerCards();
    });
}

function closeModelManager() {
    var overlay = document.getElementById('modelManagerOverlay');
    overlay.classList.remove('visible');
    setTimeout(function () {
        overlay.style.display = 'none';
    }, 300);
}

function handleModelManagerOverlayClick(event) {
    if (event.target === document.getElementById('modelManagerOverlay')) {
        closeModelManager();
    }
}
