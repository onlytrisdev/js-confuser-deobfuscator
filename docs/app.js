(function () {
    const sampleSelect = document.getElementById('sampleSelect');
    const fileInput = document.getElementById('fileInput');
    const clearBtn = document.getElementById('clearBtn');
    const themeToggle = document.getElementById('themeToggle');
    const themeIconDark = document.getElementById('themeIconDark');
    const themeIconLight = document.getElementById('themeIconLight');
    const themeLabel = document.getElementById('themeLabel');
    const runBtn = document.getElementById('runBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const workedToggle = document.getElementById('workedToggle');
    const workedText = document.getElementById('workedText');
    const taskList = document.getElementById('taskList');
    const liveActiveRow = document.getElementById('liveActiveRow');
    const liveActiveLabel = document.getElementById('liveActiveLabel');
    const liveActiveStepCounter = document.getElementById('liveActiveStepCounter');
    const summaryMainText = document.getElementById('summaryMainText');
    const summaryAdded = document.getElementById('summaryAdded');
    const summaryRemoved = document.getElementById('summaryRemoved');
    const summaryPercent = document.getElementById('summaryPercent');
    const copyBtn = document.getElementById('copyBtn');
    const copyBtnText = document.getElementById('copyBtnText');
    const downloadBtn = document.getElementById('downloadBtn');
    const inputEditor = document.getElementById('inputEditor');
    const outputEditor = document.getElementById('outputEditor');
    const inputMeta = document.getElementById('inputMeta');
    const outputMeta = document.getElementById('outputMeta');

    let worker = null;
    let activeJobId = 0;
    let jobStartPerf = 0;
    let rafHandle = 0;
    let isExpanded = false;
    let totalTransformHits = 0;

    function applyTheme(theme) {
        const next = theme === 'light' ? 'light' : 'dark';
        document.documentElement.setAttribute('data-theme', next);
        const isDark = next === 'dark';
        if (isDark) {
            themeIconDark.removeAttribute('hidden');
            themeIconLight.setAttribute('hidden', '');
        } else {
            themeIconDark.setAttribute('hidden', '');
            themeIconLight.removeAttribute('hidden');
        }
        themeLabel.textContent = isDark ? 'Light' : 'Dark';
        try {
            localStorage.setItem('deobf_theme', next);
        } catch (e) {}
    }

    function initTheme() {
        let saved = 'dark';
        try {
            saved = localStorage.getItem('deobf_theme') || 'dark';
        } catch (e) {}
        applyTheme(saved);
    }

    themeToggle.addEventListener('click', function () {
        const current = document.documentElement.getAttribute('data-theme') || 'dark';
        applyTheme(current === 'dark' ? 'light' : 'dark');
    });

    function toggleTaskFeed() {
        isExpanded = !isExpanded;
        workedToggle.classList.toggle('is-expanded', isExpanded);
        taskList.classList.toggle('is-expanded', isExpanded);
    }

    workedToggle.addEventListener('click', toggleTaskFeed);
    document.querySelector('.summary-left').addEventListener('click', toggleTaskFeed);

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function formatDuration(ms) {
        if (ms < 1000) return Math.max(0, Math.round(ms)) + 'ms';
        return (ms / 1000).toFixed(1) + 's';
    }

    function countLines(text) {
        if (!text) return 0;
        let count = 1;
        for (let i = 0; i < text.length; i++) {
            if (text.charCodeAt(i) === 10) count++;
        }
        return count;
    }

    function updateMeta() {
        const inVal = inputEditor.value || '';
        const outVal = outputEditor.value || '';
        inputMeta.textContent = formatBytes(inVal.length) + ' · ' + countLines(inVal) + ' lines';
        outputMeta.textContent = formatBytes(outVal.length) + ' · ' + countLines(outVal) + ' lines';
    }

    function startLiveClock() {
        stopLiveClock();
        jobStartPerf = performance.now();
        function tick() {
            const elapsedSec = ((performance.now() - jobStartPerf) / 1000).toFixed(1);
            workedText.textContent = 'Working · ' + elapsedSec + 's';
            rafHandle = requestAnimationFrame(tick);
        }
        rafHandle = requestAnimationFrame(tick);
    }

    function stopLiveClock(finalMs) {
        if (rafHandle) {
            cancelAnimationFrame(rafHandle);
            rafHandle = 0;
        }
        if (typeof finalMs === 'number') {
            const sec = finalMs >= 100 ? (finalMs / 1000).toFixed(1) + 's' : finalMs + 'ms';
            workedText.textContent = 'Worked for ' + sec;
        }
    }

    function createCheckIconSvg() {
        const span = document.createElement('span');
        span.className = 'task-icon';
        span.innerHTML =
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M8.5 12.5l2.3 2.3 4.7-4.8"></path></svg>';
        return span;
    }

    function createChevronSvg() {
        const span = document.createElement('span');
        span.className = 'task-icon';
        span.innerHTML =
            '<svg class="chevron-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18l6-6-6-6"></path></svg>';
        return span;
    }

    function appendCompletedTaskRow(label, durationMs) {
        const row = document.createElement('div');
        row.className = 'task-row';

        const prefix = document.createElement('span');
        prefix.className = 'task-prefix';
        prefix.textContent = 'Started';

        const icon = createCheckIconSvg();

        const text = document.createElement('span');
        text.className = 'task-label';
        text.textContent = label;

        const dur = document.createElement('span');
        dur.className = 'task-duration';
        dur.textContent = typeof durationMs === 'number' ? formatDuration(durationMs) : '';

        row.appendChild(prefix);
        row.appendChild(icon);
        row.appendChild(text);
        if (typeof durationMs === 'number') {
            row.appendChild(dur);
        }
        row.appendChild(createChevronSvg());

        taskList.appendChild(row);
        const allRows = taskList.querySelectorAll('.task-row');
        for (let i = 0; i < allRows.length; i++) {
            if (i < allRows.length - 2) {
                allRows[i].classList.add('is-collapsed-history');
            } else {
                allRows[i].classList.remove('is-collapsed-history');
            }
        }
        taskList.scrollTop = taskList.scrollHeight;
    }

    function setRunningUI(isRunning) {
        runBtn.disabled = isRunning;
        cancelBtn.hidden = !isRunning;
        liveActiveRow.hidden = !isRunning;
    }

    let detectedLayers = [];
    let autoRunTimer = 0;

    function handleProgressEvent(info) {
        if (!info) return;
        if (info.type === 'stage') {
            if (info.status === 'running') {
                liveActiveLabel.textContent = info.label;
                liveActiveStepCounter.textContent = '';
            } else if (info.status === 'done') {
                if (info.stage === 'unpack' && info.changed) {
                    totalTransformHits++;
                    if (!detectedLayers.includes('Pack/RGF')) detectedLayers.push('Pack/RGF');
                    appendCompletedTaskRow('Detected & unpacked outer RGF / Pack layer', info.stepMs);
                } else if (info.stage === 'parse') {
                    appendCompletedTaskRow('Parsed Babel AST & scanning 14 obfuscation patterns', info.stepMs);
                } else if (info.stage === 'dce' && info.changed) {
                    totalTransformHits++;
                    if (!detectedLayers.includes('Dead Code')) detectedLayers.push('Dead Code');
                    appendCompletedTaskRow('Swept unreachable dead-code clones', info.stepMs);
                } else if (info.stage === 'generate') {
                    appendCompletedTaskRow('Formatted clean JavaScript output', info.stepMs);
                }
                if (info.previewCode) {
                    outputEditor.value = info.previewCode;
                    updateMeta();
                }
            }
            return;
        }
        if (info.type === 'step-start') {
            liveActiveLabel.textContent = 'Pass ' + info.pass + ' · Scanning ' + info.stepLabel;
            liveActiveStepCounter.textContent = info.stepIndex + '/' + info.stepTotal;
            return;
        }
        if (info.type === 'step-done') {
            if (info.changed) {
                totalTransformHits++;
                if (!detectedLayers.includes(info.stepLabel)) {
                    detectedLayers.push(info.stepLabel);
                }
                appendCompletedTaskRow('Pass ' + info.pass + ' · Unwrapped ' + info.stepLabel, info.stepMs);
                summaryMainText.textContent =
                    'Detected ' +
                    detectedLayers.length +
                    (detectedLayers.length === 1 ? ' layer (' : ' layers (') +
                    totalTransformHits +
                    ' hits)';
            }
            return;
        }
        if (info.type === 'pass-done') {
            if (info.previewCode) {
                outputEditor.value = info.previewCode;
                updateMeta();
            }
        }
    }

    async function runOnMainThread(code, jobId) {
        try {
            const api = window.JSConfuserDeobfuscator;
            if (!api || typeof api.deobfuscateCodeAsync !== 'function') {
                throw new Error('Deobfuscator bundle is not loaded');
            }
            const result = await api.deobfuscateCodeAsync(code, {
                silent: true,
                yieldMs: 6,
                onProgress(info) {
                    if (jobId !== activeJobId) return;
                    handleProgressEvent(info);
                }
            });
            if (jobId !== activeJobId) return;
            applyResult(result);
        } catch (err) {
            if (jobId !== activeJobId) return;
            stopLiveClock();
            setRunningUI(false);
            workedText.textContent = 'Syntax / AST Error · ' + (err && err.message ? err.message : String(err));
        }
    }

    function applyResult(result) {
        stopLiveClock(result.elapsedMs);
        setRunningUI(false);
        outputEditor.value = result.code || '';
        updateMeta();
        if (detectedLayers.length > 0) {
            summaryMainText.textContent =
                'Auto-detected ' +
                detectedLayers.length +
                (detectedLayers.length === 1 ? ' layer' : ' layers') +
                ' (' +
                totalTransformHits +
                ' hits · ' +
                result.passes +
                (result.passes === 1 ? ' pass)' : ' passes)');
        } else {
            summaryMainText.textContent = 'No obfuscation layers detected (formatted cleanly)';
        }
        summaryAdded.textContent = '+' + formatBytes(result.outputBytes);
        summaryRemoved.textContent = '-' + formatBytes(result.inputBytes);
        summaryPercent.textContent = '(-' + result.reductionPct + '%)';
    }

    function ensureWorker() {
        if (worker) return worker;
        try {
            worker = new Worker('./deobfuscator.bundle.js');
            worker.onmessage = function (event) {
                const data = event.data || {};
                if (data.id !== activeJobId) return;
                if (data.type === 'PROGRESS') {
                    handleProgressEvent(data.info);
                } else if (data.type === 'RESULT') {
                    applyResult(data.result);
                } else if (data.type === 'ERROR') {
                    stopLiveClock();
                    setRunningUI(false);
                    workedText.textContent = 'Syntax / AST Error · ' + (data.message || 'Deobfuscation failed');
                }
            };
            worker.onerror = function (err) {
                worker = null;
                runOnMainThread(inputEditor.value, activeJobId);
                if (err && typeof err.preventDefault === 'function') err.preventDefault();
            };
            return worker;
        } catch (e) {
            worker = null;
            return null;
        }
    }

    function startDeobfuscation() {
        if (autoRunTimer) {
            clearTimeout(autoRunTimer);
            autoRunTimer = 0;
        }
        const code = inputEditor.value;
        if (!code || !code.trim()) {
            workedText.textContent = 'Paste or drop any obfuscated script to auto-deobfuscate';
            return;
        }
        activeJobId++;
        const jobId = activeJobId;
        totalTransformHits = 0;
        detectedLayers = [];
        taskList.innerHTML = '';
        summaryMainText.textContent = 'Auto-detecting obfuscation layers...';
        summaryAdded.textContent = '+0 B';
        summaryRemoved.textContent = '-' + formatBytes(code.length);
        summaryPercent.textContent = '';

        setRunningUI(true);
        liveActiveLabel.textContent = 'Scanning script structure...';
        liveActiveStepCounter.textContent = '';
        startLiveClock();

        const w = ensureWorker();
        if (w) {
            w.postMessage({
                id: jobId,
                type: 'DEOBFUSCATE',
                code,
                maxPasses: 15,
                yieldMs: 6
            });
        } else {
            runOnMainThread(code, jobId);
        }
    }

    function cancelDeobfuscation() {
        if (autoRunTimer) {
            clearTimeout(autoRunTimer);
            autoRunTimer = 0;
        }
        activeJobId++;
        stopLiveClock();
        if (worker) {
            worker.terminate();
            worker = null;
        }
        setRunningUI(false);
        workedText.textContent = 'Stopped';
    }

    function markCustomScriptMode() {
        const customOpt = sampleSelect.querySelector('option[value="custom"]');
        if (customOpt) {
            customOpt.removeAttribute('hidden');
            sampleSelect.value = 'custom';
        }
    }

    function loadSample(sampleKey) {
        const samples = window.DEOBF_SAMPLES || {};
        const item = samples[sampleKey];
        if (!item) return;
        inputEditor.value = item.code;
        outputEditor.value = '';
        updateMeta();
    }

    sampleSelect.addEventListener('change', function () {
        if (sampleSelect.value === 'custom') return;
        loadSample(sampleSelect.value);
        startDeobfuscation();
    });

    runBtn.addEventListener('click', startDeobfuscation);
    cancelBtn.addEventListener('click', cancelDeobfuscation);

    clearBtn.addEventListener('click', function () {
        if (autoRunTimer) {
            clearTimeout(autoRunTimer);
            autoRunTimer = 0;
        }
        activeJobId++;
        stopLiveClock(0);
        setRunningUI(false);
        inputEditor.value = '';
        outputEditor.value = '';
        taskList.innerHTML = '';
        workedText.textContent = 'Paste or drop any JS script to auto-deobfuscate';
        summaryMainText.textContent = 'Waiting for input script';
        summaryAdded.textContent = '+0 B';
        summaryRemoved.textContent = '-0 B';
        summaryPercent.textContent = '(0%)';
        markCustomScriptMode();
        updateMeta();
    });

    function handleUploadedFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function () {
            markCustomScriptMode();
            inputEditor.value = String(reader.result || '');
            outputEditor.value = '';
            updateMeta();
            startDeobfuscation();
        };
        reader.readAsText(file);
    }

    fileInput.addEventListener('change', function () {
        const file = fileInput.files && fileInput.files[0];
        handleUploadedFile(file);
    });

    inputEditor.addEventListener('paste', function () {
        markCustomScriptMode();
        if (autoRunTimer) clearTimeout(autoRunTimer);
        autoRunTimer = setTimeout(function () {
            updateMeta();
            startDeobfuscation();
        }, 60);
    });

    inputEditor.addEventListener('input', function () {
        markCustomScriptMode();
        updateMeta();
        if (autoRunTimer) clearTimeout(autoRunTimer);
        autoRunTimer = setTimeout(function () {
            if (inputEditor.value && inputEditor.value.trim()) {
                startDeobfuscation();
            }
        }, 500);
    });

    inputEditor.addEventListener('dragover', function (e) {
        e.preventDefault();
    });

    inputEditor.addEventListener('drop', function (e) {
        const files = e.dataTransfer && e.dataTransfer.files;
        if (files && files.length > 0) {
            e.preventDefault();
            handleUploadedFile(files[0]);
        }
    });

    copyBtn.addEventListener('click', function () {
        const text = outputEditor.value;
        if (!text) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                copyBtnText.textContent = 'Copied';
                setTimeout(function () {
                    copyBtnText.textContent = 'Copy';
                }, 1200);
            });
        }
    });

    downloadBtn.addEventListener('click', function () {
        const text = outputEditor.value;
        if (!text) return;
        const blob = new Blob([text], { type: 'application/javascript;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'deobfuscated.js';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
    });

    window.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            startDeobfuscation();
        }
    });

    initTheme();
    loadSample(sampleSelect.value);
    startDeobfuscation();
})();
