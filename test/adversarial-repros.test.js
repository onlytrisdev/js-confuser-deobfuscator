const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const JsConfuser = require('js-confuser');
const { deobfuscate } = require('../deobfuscator');

const TMP_DIR = path.join(__dirname, 'tmp_adversarial');
if (!fs.existsSync(TMP_DIR)) fs.mkdirSync(TMP_DIR, { recursive: true });
const FIXTURES_DIR = path.join(__dirname, 'fixtures');

function runCode(filePath) {
  return execSync(`node "${filePath}"`, { timeout: 15000 }).toString().trim();
}

function checkNoObfuscatorArtifacts(code) {
  const ast = parser.parse(code, { sourceType: 'unambiguous' });
  const issues = [];
  traverse(ast, {
    WhileStatement(p) {
      const test = p.node.test;
      if (
        test.type === 'BinaryExpression' &&
        (test.operator === '!==' || test.operator === '!=') &&
        p.node.body.type === 'BlockStatement' &&
        p.node.body.body.length === 1 &&
        p.node.body.body[0].type === 'SwitchStatement'
      ) {
        issues.push('Unwrapped CFF while-switch loop remaining');
      }
    },
    Identifier(p) {
      const name = p.node.name;
      if (/^__(p|f)_.*_(varMask|dispatcher|flat)/.test(name)) {
        issues.push(`Obfuscator helper identifier remaining: ${name}`);
      }
    },
  });
  return issues;
}

const CASES = [
  {
    name: 'Finding 1a: VariableMasking + Closures reading outer masked vars',
    code: `
function makeCounter(start) {
    let count = start;
    const step = 2;
    const bump = function(extra) {
        count += step + extra;
        return count;
    };
    return bump(1) + ":" + bump(3);
}
console.log(makeCounter(10));
`,
    options: { target: 'node', variableMasking: true },
  },
  {
    name: 'Finding 1b: Closures SharedState on Preset Medium (VariableMasking + Dispatcher)',
    code: `
function bank(initial) {
    let balance = initial;
    return {
        deposit(amount) { balance += amount; return balance; },
        withdraw(amount) {
            if (balance >= amount) { balance -= amount; return true; }
            return false;
        },
        getBalance() { return balance; }
    };
}
const acc = bank(100);
acc.deposit(50);
console.log(acc.withdraw(30), acc.getBalance(), acc.withdraw(200), acc.getBalance());
`,
    obfFile: path.join(FIXTURES_DIR, 'Tricky_Closures_SharedState_Preset_Medium_obf.js'),
    options: { target: 'node', preset: 'medium' },
  },
  {
    name: 'Finding 1c: Closures Loop Scoping on Preset High',
    code: `
function makeCounters() {
    let funcs = [];
    for (let i = 0; i < 5; i++) {
        funcs.push((function(val) {
            let innerCount = 0;
            return function(delta) {
                innerCount += delta;
                return val * 10 + innerCount;
            };
        })(i));
    }
    return funcs;
}
const counters = makeCounters();
console.log(counters.map(c => [c(1), c(2)]).join('|'));
`,
    obfFile: path.join(FIXTURES_DIR, 'Tricky_Closures_Loop_Scoping_Preset_High_obf.js'),
    options: { target: 'node', preset: 'high' },
  },
  {
    name: 'Finding 2: Nested Dispatcher (inner function inside outer dispatched function)',
    code: `
function outer(a) {
    function inner(b) {
        return a + b;
    }
    return inner(10) + ":" + inner(20);
}
console.log(outer(5));
`,
    options: { target: 'node', dispatcher: true },
  },
  {
    name: 'Finding 3: CFF Hoisting Order (single-assigned var/function read before assignment)',
    code: `
function checkVal() {
    return secret === undefined ? "unset" : secret;
}
function checkFn() {
    return typeof cb;
}
const beforeVal = checkVal();
const beforeFn = checkFn();
var secret = "my_secret";
var cb = function() { return "ok"; };
const afterVal = checkVal();
const afterFn = checkFn();
console.log(beforeVal + "|" + afterVal + "|" + beforeFn + "|" + afterFn + "|" + cb());
`,
    options: { target: 'node', controlFlowFlattening: true },
  },
  {
    name: 'Finding 4: Flatten on FunctionExpression / Closure',
    code: `
function makeAdder(base) {
    let count = 0;
    const add = function(val) {
        count += 1;
        base += val;
        return base + ":" + count;
    };
    return add;
}
const fn = makeAdder(10);
console.log(fn(5), fn(7));
`,
    options: { target: 'node', flatten: true },
  },
  {
    name: 'Finding 5: MovedDeclarations preserving valid caller callback parameters',
    code: `
function compute(data, callback) {
    if (!callback) {
        callback = function(x) { return x * 2; };
    }
    return callback(data);
}
console.log("compute result:", compute(10, function(x) { return x + 5; }));
`,
    options: { target: 'node', movedDeclarations: true },
  },
  {
    name: 'Finding 6: MovedDeclarations preserving ArrowFunctionExpression lexical this',
    code: `
"use strict";
const service = {
    multiplier: 10,
    calculate(val, fn) {
        if (!fn) {
            fn = (x) => x * this.multiplier;
        }
        return fn(val);
    }
};
console.log("service.calculate(5):", service.calculate(5));
`,
    options: null,
  },
  {
    name: 'Finding 7: GlobalConcealing not hijacking user object methods like handler.eval',
    code: `
const handler = {
    eval(x) {
        return "evaluated locally: " + x;
    }
};
function getHandlerMethod(action) {
    switch (action) {
        case "exec":
            return handler.eval;
    }
}
console.log(handler.eval("10 + 20"));
`,
    options: null,
  },
  {
    name: 'Finding 8a: DCE preserving side-effecting function calls (unobfuscated)',
    code: `
const auditTrail = [];
function logEvent(name) {
    auditTrail.push(name);
    return true;
}
const _initStatus = logEvent("SYSTEM_START");
console.log("Audit trail count:", auditTrail.length);
`,
    options: null,
  },
  {
    name: 'Finding 8b: DCE preserving side-effecting function calls (Preset Medium)',
    code: `
const audit = [];
function record(x) {
    audit.push(x);
    return 1;
}
const dummy = record("init");
console.log("Audit items:", audit.length);
`,
    options: { target: 'node', preset: 'medium' },
  },
  {
    name: 'Finding 9: polishAST RegExp literal conversion escaping even backslashes before slash',
    code: `
const regex = new RegExp("^[a-z]:\\\\\\\\/.*", "i");
console.log("Regex test:", regex.test("c:\\\\/test"));
`,
    options: null,
  },
  {
    name: 'Finding 10: decodeStrings not overwriting user environment detection functions',
    code: `
function detectGlobal() {
    const list = [
        typeof globalThis !== "undefined" ? globalThis : null,
        typeof global !== "undefined" ? global : null,
        typeof window !== "undefined" ? window : null
    ];
    return list[0].mySpecialEnv || "FALLBACK_ENV";
}
console.log("Detected:", detectGlobal());
`,
    options: null,
  },
  {
    name: 'Finding 11: Try/Catch/Finally Overrides on Preset Medium (Nested Rest-Param Masking)',
    code: `
function tryCatchFinally() {
    let log = [];
    function test1() {
        try {
            log.push("try");
            return 1;
        } catch (e) {
            log.push("catch");
            return 2;
        } finally {
            log.push("finally");
            return 3;
        }
    }
    const val1 = test1();
    function test2(shouldThrow) {
        try {
            log.push("t2-try");
            if (shouldThrow) throw new Error("err");
        } catch (e) {
            log.push("t2-catch:" + e.message);
        } finally {
            log.push("t2-finally");
        }
    }
    test2(true);
    test2(false);
    return val1 + "|" + log.join(",");
}
console.log(tryCatchFinally());
`,
    obfFile: path.join(FIXTURES_DIR, 'Tricky_Try_Catch_Finally_Overrides_Preset_Medium_obf.js'),
    options: { target: 'node', preset: 'medium' },
  },
  {
    name: 'Finding 12: Rest/Default Params & Destructuring on Preset High (Multi-wave CFF initVal)',
    code: `
function defaultParams(a, b = a * 2, c = a + b) {
    return a + b + c;
}
function restParams(first, second, ...rest) {
    return [first, second, rest.reduce((acc, x) => acc + x, 0)].join(':');
}
function destructuringDefaults({ x = 1, y = 2 } = {}, [z = 3] = []) {
    return x + y + z;
}
console.log(defaultParams(3));
console.log(defaultParams(3, 10));
console.log(restParams(1, 2, 3, 4, 5));
console.log(destructuringDefaults({ x: 10 }, [20]));
console.log(destructuringDefaults());
`,
    obfFile: path.join(FIXTURES_DIR, 'Tricky_Rest_Default_Params_Destructuring_Preset_High_obf.js'),
    options: { target: 'node', preset: 'high' },
  },
  {
    name: 'Finding 13 (Round 2): MovedDeclarations with recursive named FunctionExpression and arrow arguments/this',
    code: `
function outerMethod(x, fact) {
    if (!fact) {
        fact = function innerFact(n) {
            const getArgs = () => [this ? this.tag : "none", arguments[0]];
            if (n <= 1) return "1:" + getArgs().join(",");
            return n + "*" + innerFact(n - 1);
        };
    }
    return fact.call({ tag: "T" }, x);
}
console.log(outerMethod(4));
`,
    options: null,
  },
  {
    name: 'Finding 14 (Round 2): Kitchen sink CFF + VariableMasking + Flatten + Dispatcher + MovedDeclarations destructured param',
    code: `
function pipeline(inputArr, transformFn) {
    if (!transformFn) {
        transformFn = function(x) { return x * 2; };
    }
    let acc = 0;
    for (let i = 0; i < inputArr.length; i++) {
        const val = transformFn(inputArr[i]);
        if (val > 10) {
            acc += val;
        } else {
            acc -= 1;
        }
    }
    return acc;
}
console.log("Pipe default:", pipeline([3, 6, 8]));
console.log("Pipe custom:", pipeline([3, 6, 8], function(v) { return v + 10; }));
`,
    options: {
      target: 'node',
      controlFlowFlattening: true,
      variableMasking: true,
      flatten: true,
      dispatcher: true,
      movedDeclarations: true,
      opaquePredicates: true,
      calculator: true,
    },
  },
];

async function runSuite() {
  console.log('=== ADVERSARIAL REPROS & REGRESSION SUITE (17 CASES) ===\n');
  let passed = 0;
  let failed = 0;

  for (let i = 0; i < CASES.length; i++) {
    const c = CASES[i];
    const origPath = path.join(TMP_DIR, `case_${i}_orig.js`);
    const obfPath = path.join(TMP_DIR, `case_${i}_obf.js`);
    const deobfPath = path.join(TMP_DIR, `case_${i}_deobf.js`);

    fs.writeFileSync(origPath, c.code, 'utf-8');
    const expectedOut = runCode(origPath);

    let inputToDeobf = origPath;
    if (c.obfFile && fs.existsSync(c.obfFile)) {
      inputToDeobf = c.obfFile;
    } else if (c.options) {
      const obf = await JsConfuser.obfuscate(c.code, c.options);
      fs.writeFileSync(obfPath, obf.code, 'utf-8');
      inputToDeobf = obfPath;
    }

    let actualOut = '';
    let errStr = '';
    let artifacts = [];
    try {
      deobfuscate(inputToDeobf, deobfPath);
      const deobfCode = fs.readFileSync(deobfPath, 'utf-8');
      actualOut = runCode(deobfPath);
      artifacts = checkNoObfuscatorArtifacts(deobfCode);
    } catch (e) {
      errStr = e.stderr ? e.stderr.toString().trim() : e.message;
    }

    const ok = !errStr && actualOut === expectedOut && artifacts.length === 0;
    if (ok) {
      passed++;
      console.log(`  [PASS] ${c.name}`);
    } else {
      failed++;
      console.log(`  [FAIL] ${c.name}`);
      if (errStr) console.log(`         Error: ${errStr.split('\n')[0]}`);
      else if (actualOut !== expectedOut) {
        console.log(`         Expected: ${JSON.stringify(expectedOut)}`);
        console.log(`         Actual:   ${JSON.stringify(actualOut)}`);
      }
      if (artifacts.length > 0) {
        console.log(`         Artifacts: ${artifacts.join(', ')}`);
      }
    }
  }

  console.log(`\nResult: ${passed}/${CASES.length} passed, ${failed} failed.`);
  fs.rmSync(TMP_DIR, { recursive: true, force: true });
  if (failed > 0) process.exit(1);
}

runSuite().catch(e => {
  console.error(e);
  process.exit(1);
});
