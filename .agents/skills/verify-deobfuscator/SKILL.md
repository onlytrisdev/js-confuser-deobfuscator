---
name: verify-deobfuscator
description: End-to-end verification skill for js-confuser-deobfuscator. Drives the real CLI and programmatic pipeline across comprehensive, clarity-benchmark, and adversarial test suites.
---

# Verify `js-confuser-deobfuscator`

Use this skill to verify any change to `deobfuscator.js`, `src/transforms/*.js`, or `src/core/dce.js`.

## 1. Surface & Prerequisites
- **Runtime**: Node.js (`>= 18`)
- **CLI Entry**: `node deobfuscator.js <input_file.js> <output_file.js>`
- **Feature Map**: [features/README.md](../../features/README.md) and [features/deobfuscation-pipeline.md](../../features/deobfuscation-pipeline.md)

## 2. Verification Workflow (Ordered Fast-to-Full)

### Step 1: Adversarial Regression Gate (`test/adversarial-repros.test.js`)
Runs 15 targeted repros covering closure variable masking, nested dispatchers, CFF hoisting order, flattened function expressions, arrow function `this`/`arguments` binding, caller callback parameters, side-effecting IIFEs, RegExp literal slash escaping, global concealing guards, and multi-wave `Preset High` interactions:
```bash
node test/adversarial-repros.test.js
```
**Pass Criterion**: `Result: 15/15 passed, 0 failed.` (exit code `0`).

### Step 2: CLI Smoke Verification (`deobfuscator.js`)
Verify the CLI entrypoint directly on `test/fixtures/Tricky_Closures_SharedState_Preset_Medium_obf.js` and execute the resulting output:
```bash
node deobfuscator.js test/fixtures/Tricky_Closures_SharedState_Preset_Medium_obf.js test/fixtures/smoke_out.js
node test/fixtures/smoke_out.js
```
**Pass Criterion**: Exit code `0`, valid JS syntax, and stdout `120 120 false 120`. Remove `test/fixtures/smoke_out.js` after verification.

### Step 3: AST Clarity & Execution Benchmark (`test/clarity-benchmark.js`)
Runs 32 combinations (4 complex programs × 8 `js-confuser` configurations `C1`–`C8`), verifying `100%` runtime stdout equivalence and scoring AST structural clarity across 4 dimensions (Literal Recovery, Complexity Reduction, Obfuscator Artifact Purity, and Structural Similarity):
```bash
node test/clarity-benchmark.js
```
**Pass Criterion**: `execPassed=32/32 errors=0`, `MEAN_CLARITY >= 90%`, and `MIN_CONFIG >= 90%`.

### Step 4: Comprehensive E2E Suite (`test/comprehensive-test.js`)
Runs 32 freshly obfuscated end-to-end suites and asserts exact stdout parity:
```bash
node test/comprehensive-test.js
```
**Pass Criterion**: ` Passed: 32 / 32 (100.0%)` and ` Failed: 0`.
