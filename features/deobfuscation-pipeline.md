# Deobfuscation Pipeline & AST Polish

## Overview
`js-confuser-deobfuscator` restores JavaScript obfuscated with `js-confuser` (`low`, `medium`, `high`, and custom multi-layer configurations) into readable, semantically equivalent source code.

## Entry Points & CLI Surface
- **CLI Entry (`deobfuscator.js`)**:
  - `node deobfuscator.js <input_file.js> <output_file.js>`
  - Requires `<input_file.js>` and `<output_file.js>` CLI arguments (exits with status `1` and usage notice if fewer than 2 arguments are passed).
- **Programmatic API (`deobfuscator.js`)**:
  - `deobfuscate(inputPath, outputPath)` reads `<inputPath>`, runs the 6-step pipeline, and writes `js-beautify`-formatted code to `<outputPath>`.

## Pipeline Architecture (6 Steps in `deobfuscator.js`)
1. **Step 1 — Outer Layer Unpacking (`src/transforms/unpack.js`)**:
   - `unpack(code)`: Evaluates and extracts inner payloads wrapped by `js-confuser` `pack` templates.
2. **Step 2 — AST Parsing (`@babel/parser`)**:
   - Parses unpacked source with `sourceType: 'module'`, `allowReturnOutsideFunction: true`, and `plugins: ['jsx', 'typescript']`.
3. **Step 3 — Iterative Transform Loop (`while (changed && pass < 15)`)**:
   - `simplifyMovedDeclarations(ast)` (`src/transforms/moved-declarations.js`): Restores hoisted `var` function expressions to `FunctionDeclaration`s when safe, preserving `ArrowFunctionExpression` lexical `this`/`arguments` semantics and caller-passed callback parameters.
   - `inlineConstantArrays(ast)` (`src/transforms/constant-arrays.js`): Inlines static constant array references.
   - `decodeStrings(ast)` (`src/transforms/string-concealing.js`): Executes isolated decoder routines, resolves string table lookups, string splitting, compression, and array rotations, and simplifies verified `js-confuser` `getGlobal` wrappers without touching user environment checks.
   - `unwrapAstScrambler(ast)` (`src/transforms/ast-scrambler.js`): Unscrambles shuffled sequence expressions and control blocks.
   - `unwrapRgf(ast)` (`src/transforms/rgf.js`): Replaces `new Function(...)` registry arrays and calls (`rgf`) with normal AST functions.
   - `inlineGlobalConcealing(ast)` (`src/transforms/global-concealing.js`): Restores concealed global lookups (`window`, `globalThis`, `Math`, `JSON`, etc.) after verifying the base binding is an authentic global object getter.
   - `inlineCalculator(ast)` (`src/transforms/calculator.js`): Inlines arithmetic/unary calculator dispatcher functions.
   - `simplifyOpaquePredicates(ast)` (`src/transforms/opaque-predicates.js`): Evaluates static predicate functions and state arrays.
   - `unwrapDispatcher(ast)` (`src/transforms/dispatcher.js`): Resolves `dispatcher` routing functions from innermost to outermost, preserving nested closure references to the argument stack when unshadowed.
   - `unwrapFlatten(ast)` (`src/transforms/flatten.js`): Merges `flatten` wrapper functions and inner implementation functions across `FunctionDeclaration`, `FunctionExpression`, and `ArrowFunctionExpression`, including `(...restParam)` destructuring patterns.
   - `unwrapCFF(ast)` (`src/transforms/cff.js`): Traces control-flow-flattening (`switch` inside `while`) state machines, reconstructs structured loops/conditionals, unmasks CFF state slices, and restores hoisted functions and parameters without breaking temporal read-before-write order.
   - `unmaskVariables(ast)` (`src/transforms/variable-masking.js`): Unmasks array/rest-argument variable masks across outer functions and nested closures using collision-free scope identifiers.
   - `polishAST(ast)` and `cleanReachabilityDCE(ast)` (`src/core/dce.js`): Folds static branches, simplifies sequence expressions, and prunes unreachable obfuscator helper declarations (`opaquePredicates`, `deadCode`, `stringConcealing` remnants, `calculator` tables).
4. **Step 4 — Scope-Aware Reachability Dead Code Elimination (`src/core/dce.js`)**:
   - Runs `polishAST(ast)` followed by `cleanReachabilityDCE(ast)` to sweep any remaining unreachable functions and dead bindings from top-level and side-effecting roots.
5. **Step 5 — AST Syntax & Literal Polish (`src/core/dce.js`)**:
   - `polishAST(ast)`: Converts `void 0` to `undefined`, `!0`/`!1` to `true`/`false`, computed identifier properties `obj["prop"]` to `obj.prop`, and safe `new RegExp("pattern", "flags")` calls to `/pattern/flags` literals (properly escaping unescaped `/` after even backslash runs).
6. **Step 6 — Code Generation (`@babel/generator` + `js-beautify`)**:
   - Emits formatted JavaScript (`indent_size: 4`, `jsescOption: { minimal: true }`) to `<outputPath>`.

## Key Invariants
1. **Semantic Equivalence**: Executing original and deobfuscated scripts in Node.js produces identical stdout/return values across all 32 benchmark cases (`test/clarity-benchmark.js`, `test/comprehensive-test.js`) and all 15 adversarial edge-case repros (`test/adversarial-repros.test.js`).
2. **AST Clarity Threshold**: Across all 8 `js-confuser` presets and multi-plugin combinations (`C1`–`C8`), `MEAN_CLARITY >= 90%` and `MIN_CONFIG >= 90%`.
3. **Side-Effect & Scope Preservation**:
   - `isBodyFreeOfExternalSideEffects` in `src/core/dce.js` never deletes functions that invoke unknown callees, mutate outer state, or call mutating methods (`push`, `splice`, etc.).
   - `unmaskVariables` and `unwrapDispatcher` resolve inner closures referencing outer mask/stack arrays without colliding with inner variable names.
   - `simplifyMovedDeclarations` never converts `ArrowFunctionExpression` to `FunctionDeclaration` and never strips parameters passed at call sites.
