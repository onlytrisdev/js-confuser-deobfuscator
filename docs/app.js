(function () {
    const DEFAULT_OBFUSCATED_SNIPPET = [
        'var _0x4a2b = ["AUTH_OK_2026", "onlytris", ":", "log"];',
        'function _0x1f8e(_0x9c1a, _0x3d4b) {',
        '    return _0x9c1a + _0x3d4b;',
        '}',
        'function fib(_v_n) {',
        '    var _state = 0x10;',
        '    while (_state !== 0x0) {',
        '        switch (_state) {',
        '            case 0x10:',
        '                _state = _v_n <= 1 ? 0x20 : 0x30;',
        '                break;',
        '            case 0x20:',
        '                return _v_n;',
        '            case 0x30:',
        '                return _0x1f8e(fib(_v_n - 1), fib(_v_n - 2));',
        '        }',
        '    }',
        '}',
        'function verifyAccess(user, code) {',
        '    var tag = _0x4a2b[0];',
        '    return tag + _0x4a2b[2] + user + _0x4a2b[2] + fib(code);',
        '}',
        'console[_0x4a2b[3]](verifyAccess(_0x4a2b[1], 10));'
    ].join('\n');

    const JS_KEYWORDS = new Set([
        'function', 'return', 'var', 'let', 'const', 'if', 'else', 'for', 'while',
        'do', 'switch', 'case', 'break', 'continue', 'default', 'new', 'typeof',
        'void', 'delete', 'in', 'instanceof', 'try', 'catch', 'finally', 'throw',
        'class', 'extends', 'super', 'import', 'export', 'from', 'async', 'await', 'yield', 'of'
    ]);

    const JS_BUILTINS = new Set([
        'true', 'false', 'null', 'undefined', 'NaN', 'Infinity', 'this', 'arguments',
        'console', 'window', 'globalThis', 'global', 'Math', 'Object', 'Array',
        'String', 'Number', 'Boolean', 'RegExp', 'Promise', 'Map', 'Set', 'JSON',
        'Date', 'Error', 'TypeError', 'Symbol', ' BigInt', 'parseInt', 'parseFloat'
    ]);

    const fileInput = document.getElementById('fileInput');
    const clearBtn = document.getElementById('clearBtn');
    const themeToggle = document.getElementById('themeToggle');
    const themeIconDark = document.getElementById('themeIconDark');
    const themeIconLight = document.getElementById('themeIconLight');
    const themeLabel = document.getElementById('themeLabel');
    const runBtn = document.getElementById('runBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const statusDot = document.getElementById('statusDot');
    const workedToggle = document.getElementById('workedToggle');
    const workedText = document.getElementById('workedText');
    const expandStepsBtn = document.getElementById('expandStepsBtn');
    const expandStepsLabel = document.getElementById('expandStepsLabel');
    const summaryTrigger = document.getElementById('summaryTrigger');
    const taskList = document.getElementById('taskList');
    const liveActiveRow = document.getElementById('liveActiveRow');
    const liveActiveLabel = document.getElementById('liveActiveLabel');
    const liveActiveStepCounter = document.getElementById('liveActiveStepCounter');
    const latestStepPreview = document.getElementById('latestStepPreview');
    const latestStepPrefix = document.getElementById('latestStepPrefix');
    const latestStepIcon = document.getElementById('latestStepIcon');
    const latestStepText = document.getElementById('latestStepText');
    const latestStepDuration = document.getElementById('latestStepDuration');
    const summaryMainText = document.getElementById('summaryMainText');
    const summaryAdded = document.getElementById('summaryAdded');
    const summaryRemoved = document.getElementById('summaryRemoved');
    const summaryPercent = document.getElementById('summaryPercent');
    const copyBtn = document.getElementById('copyBtn');
    const copyBtnText = document.getElementById('copyBtnText');
    const downloadBtn = document.getElementById('downloadBtn');
    const inputEditor = document.getElementById('inputEditor');
    const outputEditor = document.getElementById('outputEditor');
    const inputHighlight = document.getElementById('inputHighlight');
    const outputHighlight = document.getElementById('outputHighlight');
    const inputGutter = document.getElementById('inputGutter');
    const outputGutter = document.getElementById('outputGutter');
    const inputMeta = document.getElementById('inputMeta');
    const outputMeta = document.getElementById('outputMeta');

    let worker = null;
    let activeJobId = 0;
    let jobStartPerf = 0;
    let rafHandle = 0;
    let isExpanded = false;
    let totalTransformHits = 0;
    let detectedLayers = [];

    function escapeHtml(str) {
        return str
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    function highlightJS(source) {
        if (!source) return '';
        if (source.length > 65000) {
            return escapeHtml(source);
        }
        const tokenRe = /("(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|`(?:\\[\s\S]|[^`\\])*`)|(\b0[xX][0-9a-fA-F]+\b|\b\d+(?:\.\d+)?\b)|(\.[a-zA-Z_$][\w$]*)|(\b[a-zA-Z_$][\w$]*\b)(\s*\()?|([{}()[\].,:;?+\-*/%&|^!~=<>]+)/g;
        let out = '';
        let lastIndex = 0;
        let match;
        while ((match = tokenRe.exec(source)) !== null) {
            if (match.index > lastIndex) {
                out += escapeHtml(source.slice(lastIndex, match.index));
            }
            const full = match[0];
            const strLit = match[1];
            const numLit = match[2];
            const propAccess = match[3];
            const ident = match[4];
            const callParen = match[5];
            const punct = match[6];

            if (strLit) {
                out += '<span class="tok-str">' + escapeHtml(strLit) + '</span>';
            } else if (numLit) {
                out += '<span class="tok-num">' + escapeHtml(numLit) + '</span>';
            } else if (propAccess) {
                out += '<span class="tok-op">.</span><span class="tok-prop">' + escapeHtml(propAccess.slice(1)) + '</span>';
            } else if (ident) {
                if (JS_KEYWORDS.has(ident)) {
                    out += '<span class="tok-kw">' + escapeHtml(ident) + '</span>';
                } else if (JS_BUILTINS.has(ident)) {
                    out += '<span class="tok-bool">' + escapeHtml(ident) + '</span>';
                } else if (callParen) {
                    out += '<span class="tok-fn">' + escapeHtml(ident) + '</span>';
                } else {
                    out += escapeHtml(ident);
                }
                if (callParen) {
                    out += escapeHtml(callParen);
                }
            } else if (punct) {
                out += '<span class="tok-op">' + escapeHtml(punct) + '</span>';
            } else {
                out += escapeHtml(full);
            }
            lastIndex = tokenRe.lastIndex;
        }
        if (lastIndex < source.length) {
            out += escapeHtml(source.slice(lastIndex));
        }
        if (source.endsWith('\n')) {
            out += ' ';
        }
        return out;
    }

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
        expandStepsBtn.classList.toggle('is-expanded', isExpanded);
        taskList.classList.toggle('is-expanded', isExpanded);
    }

    workedToggle.addEventListener('click', toggleTaskFeed);
    expandStepsBtn.addEventListener('click', toggleTaskFeed);
    summaryTrigger.addEventListener('click', toggleTaskFeed);

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

    function buildGutterString(lineCount) {
        const total = Math.max(1, Math.min(lineCount, 1500));
        const parts = new Array(total);
        for (let i = 0; i < total; i++) {
            parts[i] = i + 1;
        }
        return parts.join('\n');
    }

    function updateMeta() {
        const inVal = inputEditor.value || '';
        const outVal = outputEditor.value || '';
        const inLines = countLines(inVal);
        const outLines = countLines(outVal);
        inputMeta.textContent = formatBytes(inVal.length) + ' · ' + inLines + (inLines === 1 ? ' line' : ' lines');
        outputMeta.textContent = formatBytes(outVal.length) + ' · ' + outLines + (outLines === 1 ? ' line' : ' lines');
        inputGutter.textContent = buildGutterString(inLines);
        outputGutter.textContent = buildGutterString(outLines);
        inputHighlight.innerHTML = highlightJS(inVal);
        outputHighlight.innerHTML = highlightJS(outVal);
    }

    inputEditor.addEventListener('scroll', function () {
        inputGutter.scrollTop = inputEditor.scrollTop;
        inputHighlight.scrollTop = inputEditor.scrollTop;
        inputHighlight.scrollLeft = inputEditor.scrollLeft;
    });

    outputEditor.addEventListener('scroll', function () {
        outputGutter.scrollTop = outputEditor.scrollTop;
        outputHighlight.scrollTop = outputEditor.scrollTop;
        outputHighlight.scrollLeft = outputEditor.scrollLeft;
    });

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
            '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"></circle><path d="M8.5 12.5l2.3 2.3 4.7-4.8"></path></svg>';
        return span;
    }

    function appendCompletedTaskRow(label, durationMs) {
        latestStepPrefix.textContent = 'Started';
        latestStepIcon.removeAttribute('hidden');
        latestStepText.textContent = label;
        latestStepDuration.textContent = typeof durationMs === 'number' ? formatDuration(durationMs) : '';

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

        taskList.appendChild(row);
        const count = taskList.querySelectorAll('.task-row').length;
        expandStepsLabel.textContent = count + ' steps';
        taskList.scrollTop = taskList.scrollHeight;
    }

    function setRunningUI(isRunning) {
        runBtn.disabled = isRunning;
        cancelBtn.hidden = !isRunning;
        liveActiveRow.hidden = !isRunning;
        latestStepPreview.hidden = isRunning;
        statusDot.classList.toggle('is-running', isRunning);
        if (isRunning) {
            statusDot.classList.remove('is-idle');
        }
    }

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
            workedText.textContent = 'Syntax / AST Error';
            latestStepText.textContent = err && err.message ? err.message : String(err);
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
                    workedText.textContent = 'Syntax / AST Error';
                    latestStepText.textContent = data.message || 'Deobfuscation failed';
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
        const code = inputEditor.value;
        if (!code || !code.trim()) {
            workedText.textContent = 'Idle';
            latestStepPrefix.textContent = 'Status';
            latestStepIcon.setAttribute('hidden', '');
            latestStepText.textContent = 'Paste or upload a .js file first, then click Deobfuscate';
            latestStepDuration.textContent = '';
            return;
        }
        activeJobId++;
        const jobId = activeJobId;
        totalTransformHits = 0;
        detectedLayers = [];
        taskList.innerHTML = '';
        expandStepsLabel.textContent = '0 steps';
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
        activeJobId++;
        stopLiveClock();
        if (worker) {
            worker.terminate();
            worker = null;
        }
        setRunningUI(false);
        statusDot.classList.add('is-idle');
        workedText.textContent = 'Stopped';
    }

    function markInputReady(label) {
        statusDot.classList.add('is-idle');
        statusDot.classList.remove('is-running');
        workedText.textContent = 'Idle';
        latestStepPrefix.textContent = 'Input';
        latestStepIcon.setAttribute('hidden', '');
        latestStepText.textContent = label || 'Script loaded in input.js · click "Deobfuscate" to run';
        latestStepDuration.textContent = '';
        summaryMainText.textContent = 'Click Deobfuscate (or press Ctrl+Enter) to start';
    }

    runBtn.addEventListener('click', startDeobfuscation);
    cancelBtn.addEventListener('click', cancelDeobfuscation);

    clearBtn.addEventListener('click', function () {
        activeJobId++;
        stopLiveClock();
        setRunningUI(false);
        statusDot.classList.add('is-idle');
        inputEditor.value = '';
        outputEditor.value = '';
        taskList.innerHTML = '';
        expandStepsLabel.textContent = '0 steps';
        workedText.textContent = 'Idle';
        latestStepPrefix.textContent = 'Status';
        latestStepIcon.setAttribute('hidden', '');
        latestStepText.textContent = 'Paste or upload a .js file into input.js, then click Deobfuscate';
        latestStepDuration.textContent = '';
        summaryMainText.textContent = 'Waiting for input.js';
        summaryAdded.textContent = '+0 B';
        summaryRemoved.textContent = '-0 B';
        summaryPercent.textContent = '(0%)';
        updateMeta();
    });

    function handleUploadedFile(file) {
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function () {
            inputEditor.value = String(reader.result || '');
            outputEditor.value = '';
            updateMeta();
            markInputReady('Loaded ' + file.name + ' (' + formatBytes(inputEditor.value.length) + ') · click "Deobfuscate" to run');
        };
        reader.readAsText(file);
    }

    fileInput.addEventListener('change', function () {
        const file = fileInput.files && fileInput.files[0];
        handleUploadedFile(file);
    });

    inputEditor.addEventListener('input', function () {
        updateMeta();
        markInputReady('Modified input.js (' + formatBytes(inputEditor.value.length) + ') · click "Deobfuscate" to run');
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
        a.download = 'output.js';
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
    inputEditor.value = DEFAULT_OBFUSCATED_SNIPPET;
    outputEditor.value = '';
    updateMeta();
})();
