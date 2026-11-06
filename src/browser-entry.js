const { PIPELINE_STEPS, deobfuscateCode, deobfuscateCodeAsync } = require('../deobfuscator');

const stepCatalog = PIPELINE_STEPS.map((s, idx) => ({
    index: idx + 1,
    id: s.id,
    label: s.label
}));

const api = {
    stepCatalog,
    deobfuscateCode,
    deobfuscateCodeAsync
};

if (typeof globalThis !== 'undefined') {
    globalThis.JSConfuserDeobfuscator = api;
}

const isWorkerScope =
    typeof self !== 'undefined' &&
    typeof self.postMessage === 'function' &&
    typeof window === 'undefined';

if (isWorkerScope) {
    self.onmessage = async function (event) {
        const payload = event && event.data ? event.data : {};
        if (payload.type !== 'DEOBFUSCATE') return;
        const id = payload.id;
        try {
            const result = await deobfuscateCodeAsync(payload.code || '', {
                maxPasses: payload.maxPasses || 15,
                yieldMs: typeof payload.yieldMs === 'number' ? payload.yieldMs : 6,
                silent: true,
                onProgress(info) {
                    self.postMessage({
                        id,
                        type: 'PROGRESS',
                        info
                    });
                }
            });
            self.postMessage({
                id,
                type: 'RESULT',
                result
            });
        } catch (err) {
            self.postMessage({
                id,
                type: 'ERROR',
                message: err && err.message ? err.message : String(err)
            });
        }
    };
}

module.exports = api;
