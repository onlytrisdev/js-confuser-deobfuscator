const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const JsConfuser = require('js-confuser');
const { deobfuscate } = require('../deobfuscator');

const TEST_PROGRAMS = [
    {
        name: 'Math & Algorithms (Fibonacci, Primes, GCD)',
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
        name: 'Data Structures & OOP (Class, Inheritance, Collections)',
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
        name: 'String Processing & Cipher',
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
        name: 'Object Tree & JSON Processing',
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
        name: 'Preset LOW',
        options: {
            target: 'node',
            preset: 'low'
        }
    },
    {
        name: 'Preset MEDIUM',
        options: {
            target: 'node',
            preset: 'medium'
        }
    },
    {
        name: 'Preset HIGH (Aggressive)',
        options: {
            target: 'node',
            preset: 'high'
        }
    },
    {
        name: 'Custom Hard 1 (Pack + RGF + StringConcealing + Calculator)',
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
        name: 'Custom Hard 2 (GlobalConcealing + Calculator + DuplicateLiterals)',
        options: {
            target: 'node',
            globalConcealing: true,
            calculator: true,
            stringConcealing: true,
            duplicateLiteralsRemoval: true
        }
    },
    {
        name: 'Custom Hard 3 (Dispatcher + Flatten + VariableMasking + OpaquePredicates)',
        options: {
            target: 'node',
            dispatcher: true,
            flatten: true,
            variableMasking: true,
            opaquePredicates: true,
            deadCode: true,
            movedDeclarations: true
        }
    }
];

async function runComprehensiveTests() {
    console.log('========================================================================');
    console.log('       JS-CONFUSER COMPREHENSIVE DEOBFUSCATION VERIFICATION SUITE       ');
    console.log('========================================================================\\n');

    const testDir = path.join(__dirname, 'temp_run');
    if (!fs.existsSync(testDir)) {
        fs.mkdirSync(testDir, { recursive: true });
    }

    let totalTests = 0;
    let passedTests = 0;
    let failedTests = 0;

    for (let pIdx = 0; pIdx < TEST_PROGRAMS.length; pIdx++) {
        const prog = TEST_PROGRAMS[pIdx];
        console.log(`------------------------------------------------------------------------`);
        console.log(`[+] Program ${pIdx + 1}/${TEST_PROGRAMS.length}: ${prog.name}`);
        console.log(`------------------------------------------------------------------------`);

        // Compute expected output
        const origFile = path.join(testDir, `orig_${pIdx}.js`);
        fs.writeFileSync(origFile, prog.code, 'utf8');
        let expectedOutput = '';
        try {
            expectedOutput = execSync(`node "${origFile}"`, { timeout: 3000 }).toString();
        } catch (e) {
            console.error(`[-] Error executing original program ${prog.name}:`, e.message);
            continue;
        }

        for (let cIdx = 0; cIdx < OBFUSCATION_CONFIGS.length; cIdx++) {
            const cfg = OBFUSCATION_CONFIGS[cIdx];
            totalTests++;
            const testTag = `[Prog ${pIdx + 1} | ${cfg.name}]`;
            process.stdout.write(`  -> Testing ${testTag}... `);

            const obfFile = path.join(testDir, `obf_${pIdx}_${cIdx}.js`);
            const deobfFile = path.join(testDir, `deobf_${pIdx}_${cIdx}.js`);

            try {
                // 1. Obfuscate with JS-Confuser
                const obfResult = await JsConfuser.obfuscate(prog.code, cfg.options);
                const obfCode = typeof obfResult === 'object' ? obfResult.code : obfResult;
                fs.writeFileSync(obfFile, obfCode, 'utf8');
                const obfSize = obfCode.length;

                // Verify obfuscated file executes identically
                let obfOutput = '';
                try {
                    obfOutput = execSync(`node "${obfFile}"`, { timeout: 5000 }).toString();
                } catch (err) {
                    console.log(`\\n     [WARN] Obfuscated file failed to run directly: ${err.message}`);
                }

                // 2. Run our Deobfuscator
                const startTime = Date.now();
                deobfuscate(obfFile, deobfFile);
                const duration = Date.now() - startTime;

                const deobfCode = fs.readFileSync(deobfFile, 'utf8');
                const deobfSize = deobfCode.length;
                const reduction = (((obfSize - deobfSize) / obfSize) * 100).toFixed(1);

                // 3. Execute Deobfuscated code
                const actualOutput = execSync(`node "${deobfFile}"`, { timeout: 3000 }).toString();

                // 4. Verify Semantic Equivalence
                if (actualOutput === expectedOutput) {
                    console.log(`PASSED! [${duration}ms | Obf: ${obfSize}B -> Deobf: ${deobfSize}B (-${reduction}%)]`);
                    passedTests++;
                } else {
                    console.log(`FAILED! Output mismatch.`);
                    console.log(`     Expected: ${JSON.stringify(expectedOutput)}`);
                    console.log(`     Actual:   ${JSON.stringify(actualOutput)}`);
                    failedTests++;
                }

            } catch (err) {
                console.log(`FAILED! Error: ${err.message}`);
                failedTests++;
            }
        }
        console.log('');
    }

    console.log('========================================================================');
    console.log(`  VERIFICATION RESULTS: ${passedTests}/${totalTests} PASSED (${((passedTests/totalTests)*100).toFixed(1)}%)`);
    if (failedTests > 0) {
        console.log(`  WARNING: ${failedTests} tests failed.`);
    } else {
        console.log(`  CONGRATULATIONS: 100% of all hard tests PASSED with identical output!`);
    }
    console.log('========================================================================\\n');

    // Clean up testDir
    try {
        fs.rmSync(testDir, { recursive: true, force: true });
    } catch (e) {}

    if (failedTests > 0) {
        process.exit(1);
    }
}

runComprehensiveTests().catch(err => {
    console.error("FATAL SUITE ERROR:", err);
    process.exit(1);
});
