const path = require('path');
const fs = require('fs');
const esbuild = require('esbuild');

const rootDir = path.resolve(__dirname, '..');
const outDir = path.join(rootDir, 'docs');
const outFile = path.join(outDir, 'deobfuscator.bundle.js');

if (!fs.existsSync(outDir)) {
    fs.mkdirSync(outDir, { recursive: true });
}

const nodeBuiltinStubPlugin = {
    name: 'node-builtin-stub',
    setup(build) {
        build.onResolve({ filter: /^(fs|vm|path|crypto|os)$/ }, (args) => ({
            path: args.path,
            namespace: 'node-stub'
        }));
        build.onLoad({ filter: /.*/, namespace: 'node-stub' }, () => ({
            contents: 'module.exports = {};',
            loader: 'js'
        }));
    }
};

async function buildBundle() {
    const startTime = Date.now();
    await esbuild.build({
        entryPoints: [path.join(rootDir, 'src', 'browser-entry.js')],
        bundle: true,
        outfile: outFile,
        platform: 'browser',
        format: 'iife',
        target: ['es2020'],
        minify: true,
        banner: {
            js: 'globalThis.process=globalThis.process||{env:{NODE_ENV:"production"},argv:[],cwd:function(){return"/";},nextTick:function(cb){Promise.resolve().then(cb);}};globalThis.Buffer=globalThis.Buffer||{isBuffer:function(){return false;}};'
        },
        define: {
            'process.env.NODE_ENV': '"production"'
        },
        plugins: [nodeBuiltinStubPlugin]
    });
    const stat = fs.statSync(outFile);
    const kb = (stat.size / 1024).toFixed(1);
    console.log(`[+] Built docs/deobfuscator.bundle.js (${kb} KB) in ${Date.now() - startTime}ms`);
}

buildBundle().catch((err) => {
    console.error(err);
    process.exit(1);
});
