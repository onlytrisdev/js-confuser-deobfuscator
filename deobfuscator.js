const fs = require('fs');
const parser = require('@babel/parser');
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

function deobfuscate(inputPath, outputPath) {
    console.log(`[+] Reading input file: ${inputPath}`);
    let code = fs.readFileSync(inputPath, 'utf8');
    console.log('[+] Step 1: Unpacking outer layers / rgf...');
    code = unpack(code);

    console.log('[+] Step 2: Parsing AST...');
    const ast = parser.parse(code, {
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        plugins: ['jsx', 'typescript']
    });

    console.log('[+] Step 3: Running transform pipeline loop...');
    let changed = true;
    let pass = 0;
    while (changed && pass < 15) {
        changed = false;
        pass++;
        console.log(`[*] Transform Pass ${pass}...`);
        if (simplifyMovedDeclarations(ast)) changed = true;
        if (inlineConstantArrays(ast)) changed = true;
        if (decodeStrings(ast)) changed = true;
        if (unwrapAstScrambler(ast)) changed = true;
        if (unwrapRgf(ast)) changed = true;
        if (inlineGlobalConcealing(ast)) changed = true;
        if (inlineCalculator(ast)) changed = true;
        if (simplifyOpaquePredicates(ast)) changed = true;
        if (unwrapDispatcher(ast)) changed = true;
        if (unwrapFlatten(ast)) changed = true;
        if (unwrapCFF(ast)) changed = true;
        if (unmaskVariables(ast)) changed = true;
    }

    console.log('[+] Step 4: Running Scope-Aware Reachability DCE...');
    cleanReachabilityDCE(ast);

    console.log('[+] Step 5: Polishing AST syntax and literals...');
    polishAST(ast);

    console.log('[+] Step 6: Generating clean formatted code...');
    const output = generator(ast, {
        jsescOption: {
            minimal: true
        }
    });

    const cleanCode = beautify(output.code, {
        indent_size: 4
    });

    fs.writeFileSync(outputPath, cleanCode, 'utf8');
    console.log(`[+] Deobfuscation complete! Output saved to: ${outputPath}\n`);
}
if (require.main === module) {
    const args = process.argv.slice(2);
    if (args.length < 2) {
        console.log("Usage: node deobfuscator.js <input_file.js> <output_file.js>");
        process.exit(1);
    }
    deobfuscate(args[0], args[1]);
}
module.exports = {
    deobfuscate
};
