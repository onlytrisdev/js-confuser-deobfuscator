const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generator = require('@babel/generator').default;
const beautify = require('js-beautify').js;
const { unpack } = require('./src/transforms/unpack');
const { inlineConstantArrays } = require('./src/transforms/constant-arrays');
const { decodeStrings } = require('./src/transforms/string-concealing');
const { unwrapAstScrambler } = require('./src/transforms/ast-scrambler');
const { inlineGlobalConcealing } = require('./src/transforms/global-concealing');
const { inlineCalculator } = require('./src/transforms/calculator');
const { simplifyOpaquePredicates } = require('./src/transforms/opaque-predicates');
const { unwrapDispatcher } = require('./src/transforms/dispatcher');
const { unwrapFlatten } = require('./src/transforms/flatten');
const { unmaskVariables } = require('./src/transforms/variable-masking');
const { unwrapRgf } = require('./src/transforms/rgf');
const { simplifyMovedDeclarations } = require('./src/transforms/moved-declarations');
const { unwrapCFF } = require('./src/transforms/cff');
const { cleanReachabilityDCE, polishAST } = require('./src/core/dce');

const PIPELINE_STEPS = [
    { id: 'moved-declarations', label: 'Moved Declarations', fn: simplifyMovedDeclarations, tracksChange: true },
    { id: 'constant-arrays', label: 'Constant Arrays', fn: inlineConstantArrays, tracksChange: true },
    { id: 'string-concealing', label: 'String Concealing', fn: decodeStrings, tracksChange: true },
    { id: 'ast-scrambler', label: 'AST Scrambler', fn: unwrapAstScrambler, tracksChange: true },
    { id: 'rgf', label: 'RGF (new Function)', fn: unwrapRgf, tracksChange: true },
    { id: 'global-concealing', label: 'Global Concealing', fn: inlineGlobalConcealing, tracksChange: true },
    { id: 'calculator', label: 'Calculator Dispatch', fn: inlineCalculator, tracksChange: true },
    { id: 'opaque-predicates', label: 'Opaque Predicates', fn: simplifyOpaquePredicates, tracksChange: true },
    { id: 'dispatcher', label: 'Dispatcher Unwrap', fn: unwrapDispatcher, tracksChange: true },
    { id: 'flatten', label: 'Flatten Unwrap', fn: unwrapFlatten, tracksChange: true },
    { id: 'cff', label: 'Control Flow Flattening', fn: unwrapCFF, tracksChange: true },
    { id: 'variable-masking', label: 'Variable Unmasking', fn: unmaskVariables, tracksChange: true },
    { id: 'polish-ast', label: 'AST Constant Polish', fn: polishAST, tracksChange: false },
    { id: 'reachability-dce', label: 'Reachability Graph DCE', fn: cleanReachabilityDCE, tracksChange: true }
];

function runStep(fn, ast) {
    const res = Boolean(fn(ast));
    if (traverse.cache && typeof traverse.cache.clear === 'function') {
        traverse.cache.clear();
    }
    return res;
}

function deobfuscateCode(rawCode, options = {}) {
    const maxPasses = typeof options.maxPasses === 'number' ? options.maxPasses : 15;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const log = options.silent ? () => {} : (msg) => console.log(msg);
    const startTime = Date.now();
    const inputSource = String(rawCode || '');
    const inputBytes = inputSource.length;

    const emit = (payload) => {
        if (onProgress) {
            onProgress(Object.assign({ elapsedMs: Date.now() - startTime }, payload));
        }
    };

    emit({ type: 'stage', stage: 'unpack', label: 'Unpack Outer Layers', status: 'running', pass: 0 });
    log('[+] Step 1: Unpacking outer layers / rgf...');
    const tUnpack = Date.now();
    const code = unpack(inputSource);
    emit({
        type: 'stage',
        stage: 'unpack',
        label: 'Unpack Outer Layers',
        status: 'done',
        changed: code !== inputSource,
        stepMs: Date.now() - tUnpack,
        pass: 0
    });

    emit({ type: 'stage', stage: 'parse', label: 'Parse Babel AST', status: 'running', pass: 0 });
    log('[+] Step 2: Parsing AST...');
    const tParse = Date.now();
    const ast = parser.parse(code, {
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        plugins: ['jsx', 'typescript']
    });
    emit({
        type: 'stage',
        stage: 'parse',
        label: 'Parse Babel AST',
        status: 'done',
        changed: true,
        stepMs: Date.now() - tParse,
        pass: 0
    });

    log('[+] Step 3: Running transform pipeline loop...');
    let changed = true;
    let pass = 0;
    const passSummaries = [];

    while (changed && pass < maxPasses) {
        changed = false;
        pass++;
        const passStart = Date.now();
        let mutatedCount = 0;
        emit({ type: 'pass-start', pass, stage: 'transform' });
        log(`[*] Transform Pass ${pass}...`);

        for (let i = 0; i < PIPELINE_STEPS.length; i++) {
            const step = PIPELINE_STEPS[i];
            emit({
                type: 'step-start',
                pass,
                stepIndex: i + 1,
                stepTotal: PIPELINE_STEPS.length,
                stepId: step.id,
                stepLabel: step.label,
                stage: step.label
            });
            const stepStart = Date.now();
            const didChange = runStep(step.fn, ast);
            const stepMs = Date.now() - stepStart;
            if (step.tracksChange && didChange) {
                changed = true;
                mutatedCount++;
            }
            emit({
                type: 'step-done',
                pass,
                stepIndex: i + 1,
                stepTotal: PIPELINE_STEPS.length,
                stepId: step.id,
                stepLabel: step.label,
                stage: step.label,
                changed: Boolean(step.tracksChange && didChange),
                stepMs
            });
        }

        const passMs = Date.now() - passStart;
        passSummaries.push({ pass, mutatedCount, passMs });
        emit({ type: 'pass-done', pass, mutatedCount, passMs, converged: !changed });
    }

    emit({ type: 'stage', stage: 'dce', label: 'Final Reachability DCE & Polish', status: 'running', pass });
    log('[+] Step 4: Running Scope-Aware Reachability DCE...');
    const tDce = Date.now();
    runStep(polishAST, ast);
    const finalDceChanged = runStep(cleanReachabilityDCE, ast);

    log('[+] Step 5: Polishing AST syntax and literals...');
    polishAST(ast);
    emit({
        type: 'stage',
        stage: 'dce',
        label: 'Final Reachability DCE & Polish',
        status: 'done',
        changed: Boolean(finalDceChanged),
        stepMs: Date.now() - tDce,
        pass
    });

    emit({ type: 'stage', stage: 'generate', label: 'Generate & Beautify Code', status: 'running', pass });
    log('[+] Step 6: Generating clean formatted code...');
    const tGen = Date.now();
    const output = generator(ast, {
        jsescOption: {
            minimal: true
        }
    });

    const cleanCode = beautify(output.code, {
        indent_size: 4
    });
    emit({
        type: 'stage',
        stage: 'generate',
        label: 'Generate & Beautify Code',
        status: 'done',
        changed: true,
        stepMs: Date.now() - tGen,
        pass
    });

    const outputBytes = cleanCode.length;
    const elapsedMs = Date.now() - startTime;
    const reductionPct = inputBytes > 0 ? Number((((inputBytes - outputBytes) / inputBytes) * 100).toFixed(1)) : 0;

    return {
        code: cleanCode,
        passes: pass,
        passSummaries,
        elapsedMs,
        inputBytes,
        outputBytes,
        reductionPct
    };
}

function yieldTick(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function deobfuscateCodeAsync(rawCode, options = {}) {
    const maxPasses = typeof options.maxPasses === 'number' ? options.maxPasses : 15;
    const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
    const yieldMs = typeof options.yieldMs === 'number' ? options.yieldMs : 6;
    const startTime = Date.now();
    const inputSource = String(rawCode || '');
    const inputBytes = inputSource.length;

    const emit = async (payload, shouldYield) => {
        if (onProgress) {
            onProgress(Object.assign({ elapsedMs: Date.now() - startTime }, payload));
        }
        if (shouldYield && yieldMs >= 0) {
            await yieldTick(yieldMs);
        }
    };

    await emit({ type: 'stage', stage: 'unpack', label: 'Unpack Outer Layers', status: 'running', pass: 0 }, true);
    const tUnpack = Date.now();
    const code = unpack(inputSource);
    await emit({
        type: 'stage',
        stage: 'unpack',
        label: 'Unpack Outer Layers',
        status: 'done',
        changed: code !== inputSource,
        stepMs: Date.now() - tUnpack,
        pass: 0,
        previewCode: code !== inputSource ? code.slice(0, 12000) : null
    }, false);

    await emit({ type: 'stage', stage: 'parse', label: 'Parse Babel AST', status: 'running', pass: 0 }, true);
    const tParse = Date.now();
    const ast = parser.parse(code, {
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        plugins: ['jsx', 'typescript']
    });
    await emit({
        type: 'stage',
        stage: 'parse',
        label: 'Parse Babel AST',
        status: 'done',
        changed: true,
        stepMs: Date.now() - tParse,
        pass: 0
    }, false);

    let changed = true;
    let pass = 0;
    const passSummaries = [];

    while (changed && pass < maxPasses) {
        changed = false;
        pass++;
        const passStart = Date.now();
        let mutatedCount = 0;
        await emit({ type: 'pass-start', pass, stage: 'transform' }, false);

        for (let i = 0; i < PIPELINE_STEPS.length; i++) {
            const step = PIPELINE_STEPS[i];
            await emit({
                type: 'step-start',
                pass,
                stepIndex: i + 1,
                stepTotal: PIPELINE_STEPS.length,
                stepId: step.id,
                stepLabel: step.label,
                stage: step.label
            }, true);
            const stepStart = Date.now();
            const didChange = runStep(step.fn, ast);
            const stepMs = Date.now() - stepStart;
            if (step.tracksChange && didChange) {
                changed = true;
                mutatedCount++;
            }
            await emit({
                type: 'step-done',
                pass,
                stepIndex: i + 1,
                stepTotal: PIPELINE_STEPS.length,
                stepId: step.id,
                stepLabel: step.label,
                stage: step.label,
                changed: Boolean(step.tracksChange && didChange),
                stepMs
            }, false);
        }

        let previewCode = null;
        if (changed) {
            try {
                const snap = generator(ast, { jsescOption: { minimal: true } }).code;
                previewCode = snap.length <= 24000 ? beautify(snap, { indent_size: 4 }) : snap.slice(0, 24000);
            } catch (e) {}
        }
        const passMs = Date.now() - passStart;
        passSummaries.push({ pass, mutatedCount, passMs });
        await emit({ type: 'pass-done', pass, mutatedCount, passMs, converged: !changed, previewCode }, true);
    }

    await emit({ type: 'stage', stage: 'dce', label: 'Final Reachability DCE & Polish', status: 'running', pass }, true);
    const tDce = Date.now();
    runStep(polishAST, ast);
    const finalDceChanged = runStep(cleanReachabilityDCE, ast);
    polishAST(ast);
    await emit({
        type: 'stage',
        stage: 'dce',
        label: 'Final Reachability DCE & Polish',
        status: 'done',
        changed: Boolean(finalDceChanged),
        stepMs: Date.now() - tDce,
        pass
    }, false);

    await emit({ type: 'stage', stage: 'generate', label: 'Generate & Beautify Code', status: 'running', pass }, true);
    const tGen = Date.now();
    const output = generator(ast, {
        jsescOption: {
            minimal: true
        }
    });
    const cleanCode = beautify(output.code, {
        indent_size: 4
    });
    await emit({
        type: 'stage',
        stage: 'generate',
        label: 'Generate & Beautify Code',
        status: 'done',
        changed: true,
        stepMs: Date.now() - tGen,
        pass
    }, false);

    const outputBytes = cleanCode.length;
    const elapsedMs = Date.now() - startTime;
    const reductionPct = inputBytes > 0 ? Number((((inputBytes - outputBytes) / inputBytes) * 100).toFixed(1)) : 0;

    return {
        code: cleanCode,
        passes: pass,
        passSummaries,
        elapsedMs,
        inputBytes,
        outputBytes,
        reductionPct
    };
}

function deobfuscate(inputPath, outputPath) {
    const fs = require('fs');
    console.log(`[+] Reading input file: ${inputPath}`);
    const rawCode = fs.readFileSync(inputPath, 'utf8');
    const result = deobfuscateCode(rawCode);
    fs.writeFileSync(outputPath, result.code, 'utf8');
    console.log(`[+] Deobfuscation complete! Output saved to: ${outputPath}\n`);
    return result;
}

if (typeof require !== 'undefined' && require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log("Usage: node deobfuscator.js <input_file.js> <output_file.js>");
        process.exit(1);
    }
    deobfuscate(args[0], args[1]);
}

module.exports = {
    PIPELINE_STEPS,
    deobfuscate,
    deobfuscateCode,
    deobfuscateCodeAsync
};


