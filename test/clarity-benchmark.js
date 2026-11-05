const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const JsConfuser = require('js-confuser');
const { deobfuscate } = require('../deobfuscator');

function createSeededRandom(seed) {
    let a = seed >>> 0;
    return function() {
        a |= 0;
        a = (a + 0x6D2B79F5) | 0;
        let tVal = Math.imul(a ^ (a >>> 15), 1 | a);
        tVal = (tVal + Math.imul(tVal ^ (tVal >>> 7), 61 | tVal)) ^ tVal;
        return ((tVal ^ (tVal >>> 14)) >>> 0) / 4294967296;
    };
}

const TEST_PROGRAMS = [
    {
        name: 'Prog1_Math_Algorithms',
        code: `
function fib(n) {
    if (n <= 1) return n;
    let a = 0, b = 1;
    for (let i = 2; i <= n; i++) {
        let c = a + b;
        a = b;
        b = c;
    }
    return b;
}

function isPrime(n) {
    if (n <= 1) return false;
    for (let i = 2; i * i <= n; i++) {
        if (n % i === 0) return false;
    }
    return true;
}

function gcd(a, b) {
    while (b) {
        let t = b;
        b = a % b;
        a = t;
    }
    return a;
}

console.log("fib(12):", fib(12));
console.log("prime(17):", isPrime(17));
console.log("prime(18):", isPrime(18));
console.log("gcd(48, 18):", gcd(48, 18));
`
    },
    {
        name: 'Prog2_OOP_Collections',
        code: `
class Shape {
    constructor(name) {
        this.name = name;
    }
    describe() {
        return "Shape: " + this.name;
    }
}

class Rectangle extends Shape {
    constructor(w, h) {
        super("Rectangle");
        this.width = w;
        this.height = h;
    }
    area() {
        return this.width * this.height;
    }
}

const rect = new Rectangle(5, 8);
console.log(rect.describe());
console.log("Area:", rect.area());

const numbers = [1, 2, 3, 4, 5];
const squares = numbers.map(x => x * x);
const sum = squares.reduce((acc, x) => acc + x, 0);
console.log("Squares:", squares.join(","));
console.log("Sum of squares:", sum);
`
    },
    {
        name: 'Prog3_String_Cipher',
        code: `
function caesarCipher(str, shift) {
    let result = "";
    for (let i = 0; i < str.length; i++) {
        let code = str.charCodeAt(i);
        if (code >= 65 && code <= 90) {
            result += String.fromCharCode(((code - 65 + shift) % 26) + 65);
        } else if (code >= 97 && code <= 122) {
            result += String.fromCharCode(((code - 97 + shift) % 26) + 97);
        } else {
            result += str[i];
        }
    }
    return result;
}

function countWords(text) {
    const words = text.toLowerCase().split(/\\s+/);
    const counts = {};
    for (const w of words) {
        if (w) counts[w] = (counts[w] || 0) + 1;
    }
    return counts;
}

const original = "Hello World! Deobfuscator Testing 2026";
const encrypted = caesarCipher(original, 3);
const decrypted = caesarCipher(encrypted, 23);
console.log("Encrypted:", encrypted);
console.log("Decrypted match:", original === decrypted);

const freq = countWords("apple banana apple orange banana apple");
console.log("apple count:", freq["apple"]);
console.log("banana count:", freq["banana"]);
`
    },
    {
        name: 'Prog4_Object_DeepClone',
        code: `
function deepClone(obj) {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(deepClone);
    const copy = {};
    for (const key in obj) {
        if (Object.prototype.hasOwnProperty.call(obj, key)) {
            copy[key] = deepClone(obj[key]);
        }
    }
    return copy;
}

const originalData = {
    user: { id: 101, username: "dev_user" },
    permissions: ["read", "write", "admin"],
    active: true,
    stats: { score: 99.5, level: 4 }
};

const cloned = deepClone(originalData);
cloned.stats.score = 100.0;
cloned.permissions.push("super");

console.log("Orig score:", originalData.stats.score);
console.log("Cloned score:", cloned.stats.score);
console.log("Cloned perms:", cloned.permissions.length);
`
    }
];

const OBFUSCATION_CONFIGS = [
    {
        name: 'C1_Preset_LOW',
        options: { target: 'node', preset: 'low' }
    },
    {
        name: 'C2_Preset_MEDIUM',
        options: { target: 'node', preset: 'medium' }
    },
    {
        name: 'C3_Preset_HIGH',
        options: { target: 'node', preset: 'high' }
    },
    {
        name: 'C4_Pack_RGF_Strings_Calc',
        options: {
            target: 'node',
            pack: true,
            rgf: true,
            stringConcealing: true,
            stringSplitting: true,
            stringEncoding: true,
            calculator: true,
            duplicateLiteralsRemoval: true
        }
    },
    {
        name: 'C5_Globals_Calc_DupLiterals',
        options: {
            target: 'node',
            globalConcealing: true,
            calculator: true,
            stringConcealing: true,
            duplicateLiteralsRemoval: true
        }
    },
    {
        name: 'C6_Disp_Flatten_Mask_Opaque',
        options: {
            target: 'node',
            dispatcher: true,
            flatten: true,
            variableMasking: true,
            opaquePredicates: true,
            deadCode: true,
            movedDeclarations: true
        }
    },
    {
        name: 'C7_CFF100_DeadCode_Moved_Scram_Min',
        options: {
            target: 'node',
            controlFlowFlattening: true,
            deadCode: true,
            opaquePredicates: true,
            movedDeclarations: true,
            astScrambler: true,
            minify: true,
            duplicateLiteralsRemoval: true,
            stringConcealing: true,
            globalConcealing: true
        }
    },
    {
        name: 'C8_ObjExtract_Split_Hex_Pack_Rename',
        options: {
            target: 'node',
            objectExtraction: true,
            stringConcealing: true,
            stringSplitting: true,
            stringEncoding: true,
            hexadecimalNumbers: true,
            movedDeclarations: true,
            astScrambler: true,
            minify: true,
            renameVariables: true,
            pack: true
        }
    }
];

const STRUCTURAL_TYPES = [
    'FunctionDeclaration',
    'ClassDeclaration',
    'ClassMethod',
    'IfStatement',
    'ForStatement',
    'WhileStatement',
    'ForOfStatement',
    'ForInStatement',
    'ReturnStatement',
    'CallExpression',
    'BinaryExpression'
];

function extractAstProfile(code) {
    const ast = parser.parse(code, {
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        plugins: ['jsx', 'typescript']
    });

    let nodeCount = 0;
    const strings = new Set();
    const numbers = new Set();
    const propNames = new Set();
    const globals = new Set();
    const structCounts = new Map(STRUCTURAL_TYPES.map(k => [k, 0]));

    let artifactCount = 0;

    traverse(ast, {
        enter(p) {
            nodeCount++;
            if (structCounts.has(p.node.type)) {
                structCounts.set(p.node.type, structCounts.get(p.node.type) + 1);
            }
        },
        StringLiteral(p) {
            if (p.node.value.length > 0) {
                strings.add(p.node.value);
            }
            if (p.node.value.length >= 85 && /^[\x20-\x7e]+$/.test(p.node.value) && !p.node.value.includes(' ')) {
                artifactCount++;
            }
        },
        NumericLiteral(p) {
            numbers.add(p.node.value);
            if (p.node.value === 0x9e3779b9 || p.node.value === 2654435769) {
                artifactCount++;
            }
        },
        MemberExpression(p) {
            if (!p.node.computed && t.isIdentifier(p.node.property)) {
                propNames.add(p.node.property.name);
            } else if (p.node.computed && t.isStringLiteral(p.node.property)) {
                propNames.add(p.node.property.value);
                if (/^[$A-Z_][0-9A-Z_$]*$/i.test(p.node.property.value)) {
                    artifactCount++;
                }
            }
            if (t.isMemberExpression(p.node.object) && t.isIdentifier(p.node.object.object)) {
                const rootName = p.node.object.object.name;
                if (rootName.startsWith('_')) {
                    artifactCount++;
                }
            }
        },
        Identifier(p) {
            if (p.isReferencedIdentifier() && !p.scope.getBinding(p.node.name)) {
                globals.add(p.node.name);
            }
            if (p.node.name.startsWith('_disp_fn_')) {
                artifactCount++;
            }
        },
        SequenceExpression(p) {
            if (p.node.expressions.length === 2 && t.isNumericLiteral(p.node.expressions[0], { value: 1 })) {
                artifactCount++;
            }
        },
        SwitchStatement(p) {
            if (p.node.cases.length >= 4) {
                artifactCount++;
            }
        },
        ObjectMethod(p) {
            if (p.node.kind === 'get' || p.node.kind === 'set') {
                artifactCount++;
            }
        },
        CallExpression(p) {
            if (p.parentPath.isExpressionStatement() && p.parentPath.parentPath.isProgram() &&
                (t.isFunctionExpression(p.node.callee) || t.isArrowFunctionExpression(p.node.callee))) {
                artifactCount++;
            }
        }
    });

    return {
        nodeCount,
        strings,
        numbers,
        propNames,
        globals,
        structCounts,
        artifactCount
    };
}

function computeClarityMetrics(origProfile, deobfProfile) {
    let totalTokens = 0;
    let matchedTokens = 0;

    for (const s of origProfile.strings) {
        totalTokens++;
        if (deobfProfile.strings.has(s)) matchedTokens++;
    }
    for (const n of origProfile.numbers) {
        totalTokens++;
        if (deobfProfile.numbers.has(n)) matchedTokens++;
    }
    for (const prop of origProfile.propNames) {
        totalTokens++;
        if (deobfProfile.propNames.has(prop)) matchedTokens++;
    }
    for (const g of origProfile.globals) {
        totalTokens++;
        if (deobfProfile.globals.has(g)) matchedTokens++;
    }

    const literalRecovery = totalTokens === 0 ? 100 : (matchedTokens / totalTokens) * 100;
    const nodeCompactness = Math.min(1, origProfile.nodeCount / Math.max(1, deobfProfile.nodeCount)) * 100;
    const artifactPurity = Math.max(0, 100 - deobfProfile.artifactCount * 15);

    let minSum = 0;
    let maxSum = 0;
    for (const k of STRUCTURAL_TYPES) {
        const a = origProfile.structCounts.get(k) || 0;
        const b = deobfProfile.structCounts.get(k) || 0;
        minSum += Math.min(a, b);
        maxSum += Math.max(a, b);
    }
    const structureSimilarity = maxSum === 0 ? 100 : (minSum / maxSum) * 100;

    const clarityScore = (
        0.30 * literalRecovery +
        0.35 * nodeCompactness +
        0.20 * artifactPurity +
        0.15 * structureSimilarity
    );

    return {
        clarityScore,
        literalRecovery,
        nodeCompactness,
        artifactPurity,
        structureSimilarity
    };
}

async function runBenchmark() {
    const tmpDir = path.join(__dirname, 'temp_run_bench');
    const cacheDir = path.join(__dirname, '..', '.audit', 'obf_cache');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.mkdirSync(cacheDir, { recursive: true });

    const origLog = console.log;
    let totalCases = 0;
    let passedExec = 0;
    let errors = 0;
    let totalObfNodes = 0;
    let totalDeobfNodes = 0;
    let totalDeobfMs = 0;
    const configScores = new Map(OBFUSCATION_CONFIGS.map(c => [c.name, []]));

    for (let pIdx = 0; pIdx < TEST_PROGRAMS.length; pIdx++) {
        const prog = TEST_PROGRAMS[pIdx];
        const origProfile = extractAstProfile(prog.code);
        const origFile = path.join(tmpDir, `orig_${pIdx}.js`);
        fs.writeFileSync(origFile, prog.code, 'utf8');
        const expectedOutput = execSync(`node "${origFile}"`, { timeout: 3000 }).toString();

        for (let cIdx = 0; cIdx < OBFUSCATION_CONFIGS.length; cIdx++) {
            const cfg = OBFUSCATION_CONFIGS[cIdx];
            totalCases++;

            const seed = 1000 + pIdx * 100 + cIdx * 10;
            const cachedObfFile = path.join(cacheDir, `obf_${pIdx}_${cIdx}_${seed}.js`);
            let obfCode;
            if (fs.existsSync(cachedObfFile)) {
                obfCode = fs.readFileSync(cachedObfFile, 'utf8');
            } else {
                const origMathRandom = Math.random;
                Math.random = createSeededRandom(seed);
                try {
                    const obfRes = await JsConfuser.obfuscate(prog.code, cfg.options);
                    obfCode = typeof obfRes === 'object' ? obfRes.code : obfRes;
                    fs.writeFileSync(cachedObfFile, obfCode, 'utf8');
                } finally {
                    Math.random = origMathRandom;
                }
            }

            const obfFile = path.join(tmpDir, `obf_${pIdx}_${cIdx}.js`);
            const deobfFile = path.join(tmpDir, `deobf_${pIdx}_${cIdx}.js`);
            fs.writeFileSync(obfFile, obfCode, 'utf8');

            try {
                const obfAst = parser.parse(obfCode, { sourceType: 'module', allowReturnOutsideFunction: true });
                traverse(obfAst, { enter() { totalObfNodes++; } });
            } catch (e) {}

            const t0 = Date.now();
            try {
                console.log = () => {};
                deobfuscate(obfFile, deobfFile);
            } catch (err) {
                console.log = origLog;
                errors++;
                configScores.get(cfg.name).push({ clarityScore: 0, literalRecovery: 0, nodeCompactness: 0, artifactPurity: 0, structureSimilarity: 0, error: err.message });
                continue;
            } finally {
                console.log = origLog;
                totalDeobfMs += (Date.now() - t0);
            }

            try {
                const actualOutput = execSync(`node "${deobfFile}"`, { timeout: 3000 }).toString();
                if (actualOutput !== expectedOutput) {
                    errors++;
                    configScores.get(cfg.name).push({ clarityScore: 0, literalRecovery: 0, nodeCompactness: 0, artifactPurity: 0, structureSimilarity: 0, error: 'Output mismatch' });
                    continue;
                }
                passedExec++;
                const deobfCode = fs.readFileSync(deobfFile, 'utf8');
                const deobfProfile = extractAstProfile(deobfCode);
                totalDeobfNodes += deobfProfile.nodeCount;
                const metrics = computeClarityMetrics(origProfile, deobfProfile);
                configScores.get(cfg.name).push({
                    ...metrics,
                    origNodes: origProfile.nodeCount,
                    deobfNodes: deobfProfile.nodeCount,
                    artifacts: deobfProfile.artifactCount
                });
            } catch (err) {
                errors++;
                configScores.get(cfg.name).push({ clarityScore: 0, literalRecovery: 0, nodeCompactness: 0, artifactPurity: 0, structureSimilarity: 0, error: err.message });
            }
        }
    }

    try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch (e) {}

    console.log('========================================================================================');
    console.log('                      DEOBFUSCATION AST CLARITY BENCHMARK HARNESS                       ');
    console.log('========================================================================================');
    let allScores = [];
    let minConfigMean = 100;
    for (const [cfgName, list] of configScores.entries()) {
        const meanClarity = list.reduce((a, b) => a + b.clarityScore, 0) / list.length;
        const meanLit = list.reduce((a, b) => a + b.literalRecovery, 0) / list.length;
        const meanComp = list.reduce((a, b) => a + b.nodeCompactness, 0) / list.length;
        const meanPur = list.reduce((a, b) => a + b.artifactPurity, 0) / list.length;
        const meanStruct = list.reduce((a, b) => a + b.structureSimilarity, 0) / list.length;
        allScores.push(...list.map(x => x.clarityScore));
        if (meanClarity < minConfigMean) minConfigMean = meanClarity;
        console.log(
            `${cfgName.padEnd(36)} | Clarity: ${meanClarity.toFixed(1).padStart(5)}% ` +
            `(Lit:${meanLit.toFixed(0).padStart(3)}% Comp:${meanComp.toFixed(0).padStart(3)}% ` +
            `Pure:${meanPur.toFixed(0).padStart(3)}% Struct:${meanStruct.toFixed(0).padStart(3)}%)`
        );
    }
    const overallMean = allScores.reduce((a, b) => a + b, 0) / allScores.length;
    console.log('----------------------------------------------------------------------------------------');
    console.log(
        `SUMMARY | cases=${totalCases} execPassed=${passedExec}/${totalCases} errors=${errors} ` +
        `obfNodes=${totalObfNodes} deobfNodes=${totalDeobfNodes} time=${totalDeobfMs}ms | ` +
        `MEAN_CLARITY=${overallMean.toFixed(2)}% MIN_CONFIG=${minConfigMean.toFixed(2)}%`
    );
    console.log('========================================================================================');

    if (errors > 0) process.exit(1);
}

if (require.main === module) {
    runBenchmark().catch(err => {
        console.error(err);
        process.exit(1);
    });
}

module.exports = { runBenchmark, extractAstProfile, computeClarityMetrics };
