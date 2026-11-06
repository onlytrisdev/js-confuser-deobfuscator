(function () {
    const STEP_DEFS = [
        { id: 'moved-declarations', short: '01 Moved Decl' },
        { id: 'constant-arrays', short: '02 Const Array' },
        { id: 'string-concealing', short: '03 String Sandbox' },
        { id: 'ast-scrambler', short: '04 AST Scrambler' },
        { id: 'rgf', short: '05 RGF Unwrap' },
        { id: 'global-concealing', short: '06 Global Conceal' },
        { id: 'calculator', short: '07 Calculator' },
        { id: 'opaque-predicates', short: '08 Opaque Pred' },
        { id: 'dispatcher', short: '09 Dispatcher' },
        { id: 'flatten', short: '10 Flatten' },
        { id: 'cff', short: '11 CFF State' },
        { id: 'variable-masking', short: '12 Var Masking' },
        { id: 'polish-ast', short: '13 AST Polish' },
        { id: 'reachability-dce', short: '14 Graph DCE' }
    ];

    const brandDot = document.getElementById('brandDot');
    const sampleSelect = document.getElementById('sampleSelect');
    const fileInput = document.getElementById('fileInput');
    const clearBtn = document.getElementById('clearBtn');
    const runBtn = document.getElementById('runBtn');
    const cancelBtn = document.getElementById('cancelBtn');
    const copyBtn = document.getElementById('copyBtn');
    const downloadBtn = document.getElementById('downloadBtn');
    const inputEditor = document.getElementById('inputEditor');
    const outputEditor = document.getElementById('outputEditor');
    const inputMeta = document.getElementById('inputMeta');
    const outputMeta = document.getElementById('outputMeta');
    const statusBadge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const liveStepTitle = document.getElementById('liveStepTitle');
    const liveStepCounter = document.getElementById('liveStepCounter');
    const liveTimer = document.getElementById('liveTimer');
    const passHistory = document.getElementById('passHistory');
    const progressBar = document.getElementById('progressBar');
    const stepGrid = document.getElementById('stepGrid');
    const metricPasses = document.getElementById('metricPasses');
    const metricTime = document.getElementById('metricTime');
    const metricReduction = document.getElementById('metricReduction');

    let worker = null;
    let activeJobId = 0;
    let jobStartPerf = 0;
    let rafHandle = 0;
    const stepStats = new Map();
    const stepElements = new Map();

    function initStepGrid() {
        stepGrid.innerHTML = '';
        stepStats.clear();
        stepElements.clear();
        for (let i = 0; i < STEP_DEFS.length; i++) {
            const def = STEP_DEFS[i];
            stepStats.set(def.id, { hits: 0, totalMs: 0, checked: false });
            const card = document.createElement('div');
            card.className = 'step-card';
            card.dataset.stepId = def.id;

            const left = document.createElement('div');
            left.className = 'step-left';

            const dot = document.createElement('span');
            dot.className = 'step-dot';

            const name = document.createElement('span');
            name.className = 'step-name';
            name.textContent = def.short;

            const meta = document.createElement('span');
            meta.className = 'step-meta';
            meta.textContent = '-';

            left.appendChild(dot);
            left.appendChild(name);
            card.appendChild(left);
            card.appendChild(meta);
            stepGrid.appendChild(card);
            stepElements.set(def.id, { card, meta });
        }
    }

    function resetStepGrid() {
        passHistory.innerHTML = '';
        progressBar.style.width = '0%';
        liveStepCounter.textContent = '0 / ' + STEP_DEFS.length + ' steps';
        liveTimer.textContent = '0 ms';
        for (let i = 0; i < STEP_DEFS.length; i++) {
            const def = STEP_DEFS[i];
            stepStats.set(def.id, { hits: 0, totalMs: 0, checked: false });
            const el = stepElements.get(def.id);
            if (el) {
                el.card.className = 'step-card';
                el.meta.textContent = '-';
            }
        }
    }

    function startLiveClock() {
        stopLiveClock();
        jobStartPerf = performance.now();
        function tick() {
            const elapsed = Math.max(0, Math.round(performance.now() - jobStartPerf));
            liveTimer.textContent = elapsed + ' ms';
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
            liveTimer.textContent = finalMs + ' ms';
        }
    }

    function formatBytes(bytes) {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
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

    function setState(state, headline, footerMsg) {
        statusBadge.className = 'badge badge-' + state.toLowerCase();
        statusBadge.textContent = state;
        liveStepTitle.textContent = headline;
        if (footerMsg) {
            statusText.textContent = footerMsg;
        }
        const isRunning = state === 'RUNNING';
        runBtn.disabled = isRunning;
        cancelBtn.hidden = !isRunning;
        if (isRunning) {
            brandDot.classList.add('is-running');
        } else {
            brandDot.classList.remove('is-running');
        }
    }

    function renderStepCardState(stepId, isRunningNow) {
        const el = stepElements.get(stepId);
        const st = stepStats.get(stepId);
        if (!el || !st) return;
        if (isRunningNow) {
            el.card.className = 'step-card is-running';
            el.meta.textContent = 'run...';
            return;
        }
        if (st.hits > 0) {
            el.card.className = 'step-card is-applied';
            el.meta.textContent = st.hits + 'x · ' + st.totalMs + 'ms';
        } else if (st.checked) {
            el.card.className = 'step-card is-checked';
            el.meta.textContent = st.totalMs + 'ms';
        } else {
            el.card.className = 'step-card';
            el.meta.textContent = '-';
        }
    }

    function handleProgressEvent(info) {
        if (!info) return;
        if (info.type === 'stage') {
            const linkedStepId = info.stage === 'unpack' ? 'rgf' : info.stage === 'dce' ? 'reachability-dce' : null;
            if (info.status === 'running') {
                setState('RUNNING', info.label + '...', 'Running stage: ' + info.label);
                if (linkedStepId) renderStepCardState(linkedStepId, true);
            } else if (info.status === 'done') {
                if (linkedStepId) {
                    const st = stepStats.get(linkedStepId);
                    if (st) {
                        st.checked = true;
                        st.totalMs += info.stepMs || 0;
                        if (info.changed) st.hits += 1;
                    }
                    renderStepCardState(linkedStepId, false);
                }
                if (info.previewCode) {
                    outputEditor.value = info.previewCode;
                    updateMeta();
                }
            }
            return;
        }
        if (info.type === 'pass-start') {
            metricPasses.textContent = 'Passes: ' + info.pass;
            progressBar.style.width = '4%';
            setState('RUNNING', 'Pass ' + info.pass + ' · Starting 14 AST transforms...', 'Executing Pass ' + info.pass);
            return;
        }
        if (info.type === 'step-start') {
            const pct = Math.min(98, Math.round(((info.stepIndex - 0.5) / info.stepTotal) * 100));
            progressBar.style.width = pct + '%';
            liveStepCounter.textContent = 'Pass ' + info.pass + ' · ' + info.stepIndex + ' / ' + info.stepTotal + ' steps';
            setState(
                'RUNNING',
                'Pass ' + info.pass + ' · [' + info.stepIndex + '/' + info.stepTotal + '] ' + info.stepLabel,
                'Running transform: ' + info.stepLabel
            );
            renderStepCardState(info.stepId, true);
            return;
        }
        if (info.type === 'step-done') {
            const st = stepStats.get(info.stepId);
            if (st) {
                st.checked = true;
                st.totalMs += info.stepMs || 0;
                if (info.changed) {
                    st.hits += 1;
                }
            }
            renderStepCardState(info.stepId, false);
            const pct = Math.min(99, Math.round((info.stepIndex / info.stepTotal) * 100));
            progressBar.style.width = pct + '%';
            liveStepCounter.textContent = 'Pass ' + info.pass + ' · ' + info.stepIndex + ' / ' + info.stepTotal + ' steps';
            return;
        }
        if (info.type === 'pass-done') {
            const pill = document.createElement('span');
            pill.className = 'pass-pill' + (info.mutatedCount > 0 ? ' has-mutations' : '');
            pill.textContent =
                info.mutatedCount > 0
                    ? 'P' + info.pass + ': ' + info.mutatedCount + ' hits (' + info.passMs + 'ms)'
                    : 'P' + info.pass + ': converged (' + info.passMs + 'ms)';
            passHistory.appendChild(pill);
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
            setState('ERROR', 'Pipeline Error', err && err.message ? err.message : String(err));
        }
    }

    function applyResult(result) {
        stopLiveClock(result.elapsedMs);
        progressBar.style.width = '100%';
        liveStepCounter.textContent = STEP_DEFS.length + ' / ' + STEP_DEFS.length + ' steps';
        outputEditor.value = result.code || '';
        updateMeta();
        metricPasses.textContent = 'Passes: ' + result.passes;
        metricTime.textContent = 'Time: ' + result.elapsedMs + ' ms';
        metricReduction.textContent =
            'Reduction: ' +
            formatBytes(result.inputBytes) +
            ' -> ' +
            formatBytes(result.outputBytes) +
            ' (-' +
            result.reductionPct +
            '%)';
        let totalApplied = 0;
        stepStats.forEach(function (st) {
            totalApplied += st.hits;
        });
        setState(
            'DONE',
            'Completed ' + result.passes + ' passes (' + totalApplied + ' transform hits) in ' + result.elapsedMs + ' ms',
            'Deobfuscated in ' + result.elapsedMs + ' ms'
        );
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
                    setState('ERROR', 'Pipeline Error', data.message || 'Deobfuscation error');
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
            setState('IDLE', 'Paste or select an obfuscated script first', 'Ready');
            return;
        }
        activeJobId++;
        const jobId = activeJobId;
        resetStepGrid();
        startLiveClock();
        setState('RUNNING', 'Initializing AST Pipeline...', 'Starting deobfuscation pipeline...');
        metricPasses.textContent = 'Passes: 0';
        metricTime.textContent = 'Time: ...';
        metricReduction.textContent = 'Reduction: ...';

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
        setState('IDLE', 'Cancelled by user', 'Cancelled');
    }

    function loadSample(sampleKey) {
        const samples = window.DEOBF_SAMPLES || {};
        const item = samples[sampleKey];
        if (!item) return;
        inputEditor.value = item.code;
        outputEditor.value = '';
        updateMeta();
        setState('IDLE', 'Loaded ' + item.label, 'Loaded ' + item.label);
    }

    sampleSelect.addEventListener('change', function () {
        loadSample(sampleSelect.value);
        startDeobfuscation();
    });

    runBtn.addEventListener('click', startDeobfuscation);
    cancelBtn.addEventListener('click', cancelDeobfuscation);

    clearBtn.addEventListener('click', function () {
        activeJobId++;
        stopLiveClock(0);
        inputEditor.value = '';
        outputEditor.value = '';
        resetStepGrid();
        updateMeta();
        metricPasses.textContent = 'Passes: -';
        metricTime.textContent = 'Time: -';
        metricReduction.textContent = 'Reduction: -';
        setState('IDLE', 'Ready (Ctrl+Enter to run)', 'Cleared');
    });

    fileInput.addEventListener('change', function () {
        const file = fileInput.files && fileInput.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = function () {
            inputEditor.value = String(reader.result || '');
            outputEditor.value = '';
            updateMeta();
            setState('IDLE', 'Loaded file: ' + file.name, 'Loaded file: ' + file.name);
            startDeobfuscation();
        };
        reader.readAsText(file);
    });

    copyBtn.addEventListener('click', function () {
        const text = outputEditor.value;
        if (!text) return;
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function () {
                copyBtn.textContent = 'Copied';
                setTimeout(function () {
                    copyBtn.textContent = 'Copy';
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

    inputEditor.addEventListener('input', updateMeta);

    window.addEventListener('keydown', function (event) {
        if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
            event.preventDefault();
            startDeobfuscation();
        }
    });

    initStepGrid();
    loadSample(sampleSelect.value);
    startDeobfuscation();
})();
