const fs = require('fs');
const path = require('path');
const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generator = require('@babel/generator').default;
const t = require('@babel/types');
const vm = require('vm');
const beautify = require('js-beautify').js;
const {
    safeGlobals,
    isExpressionSafe,
    getReferencedTopLevelNames,
    getParentFunctionNames
} = require('./src/utils/ast-utils');
const {
    detectGlobalInjects,
    unpackCode
} = require('./src/utils/unpack-utils');
const {
    isBoilerplateConstant,
    matchesRetrievePattern,
    isBoilerplateHelper,
    isArgumentSafeForSandbox
} = require('./src/core/sandbox-vm');
const {
    simplifyAST
} = require('./src/core/simplifier');
const {
    cleanBoilerplateDCE,
    removeUnusedDeclarations
} = require('./src/core/dce');

function deobfuscate(inputPath, outputPath) {
    console.log(`[+] Reading input file: ${inputPath}`);
    let code = fs.readFileSync(inputPath, 'utf8');
    const injectBindings = [];
    const seenInjectParams = new Set();

    function addInjectBindings(src) {
        const found = detectGlobalInjects(src);
        found.forEach(b => {
            if (!seenInjectParams.has(b.name)) {
                seenInjectParams.add(b.name);
                injectBindings.push(b);
            }
        });
    }
    let currentCode = code;
    addInjectBindings(currentCode);
    let vmUnpacked = true;
    let vmUnpackLayers = 0;
    while (vmUnpacked && vmUnpackLayers < 5) {
        vmUnpacked = false;
        let capturedCode = null;
        const vmSandbox = {
            console: {
                log: () => {}
            },
            global: null,
            globalThis: null,
            window: null,
            document: {},
            TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
            TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : undefined,
            Buffer: typeof Buffer !== 'undefined' ? Buffer : undefined
        };
        vmSandbox.global = vmSandbox;
        vmSandbox.globalThis = vmSandbox;
        vmSandbox.window = vmSandbox;
        const vmContext = vm.createContext(vmSandbox);
        const originalVMFunction = vm.runInContext('Function', vmContext);
        vmSandbox.Function = function(...args) {
            const body = args[args.length - 1];
            if (typeof body === 'string' && body.length > 50) {
                try {
                    parser.parse(body, {
                        sourceType: 'module',
                        allowReturnOutsideFunction: true
                    });
                    capturedCode = body;
                } catch (e) {}
            }
            return originalVMFunction.apply(this, args);
        };
        try {
            vm.runInContext(currentCode, vmContext, {
                timeout: 1000
            });
        } catch (e) {}
        if (capturedCode && capturedCode !== currentCode) {
            currentCode = capturedCode;
            addInjectBindings(currentCode);
            vmUnpacked = true;
            vmUnpackLayers++;
            console.log(`[+] VM Unpacked layer ${vmUnpackLayers} (size: ${currentCode.length} chars)`);
        }
    }
    code = currentCode;
    code = unpackCode(code);
    console.log(`[+] Parsing code to AST...`);
    const ast = parser.parse(code, {
        sourceType: 'module',
        allowReturnOutsideFunction: true,
        plugins: ['jsx', 'typescript']
    });
    traverse(ast, {
        Program(pathNode) {
            pathNode.scope.crawl();
        }
    });
    console.log("[+] Performing Alpha Renaming to eliminate variable shadowing...");
    traverse(ast, {
        Scope(pathNode) {
            if (pathNode.isProgram()) return;
            Object.keys(pathNode.scope.bindings).forEach(name => {
                const uniqueName = pathNode.scope.generateUid(name);
                pathNode.scope.rename(name, uniqueName);
            });
        }
    });
    traverse(ast, {
        Program(pathNode) {
            pathNode.scope.crawl();
        }
    });
    console.log("[+] Identifying boilerplate data variables...");
    const boilerplateDataVars = new Set();
    traverse(ast, {
        VariableDeclarator(pathNode) {
            const init = pathNode.node.init;
            if (init) {
                if (t.isStringLiteral(init) && init.value.length > 50) {
                    boilerplateDataVars.add(pathNode.node.id.name);
                } else if (t.isArrayExpression(init) && init.elements.length > 10) {
                    boilerplateDataVars.add(pathNode.node.id.name);
                }
            }
        },
        AssignmentExpression(pathNode) {
            const right = pathNode.node.right;
            if (t.isIdentifier(pathNode.node.left)) {
                const name = pathNode.node.left.name;
                if (t.isStringLiteral(right) && right.value.length > 50) {
                    boilerplateDataVars.add(name);
                } else if (t.isArrayExpression(right) && right.elements.length > 10) {
                    boilerplateDataVars.add(name);
                }
            }
        }
    });
    console.log("[+] Identified Boilerplate Data Variables:", Array.from(boilerplateDataVars));
    const bindings = new Map();
    const allNames = new Set();
    injectBindings.forEach(b => allNames.add(b.name));
    traverse(ast, {
        FunctionDeclaration(pathNode) {
            if (pathNode.node.id) {
                const name = pathNode.node.id.name;
                bindings.set(name, {
                    type: 'func',
                    node: pathNode.node,
                    path: pathNode,
                    index: pathNode.node.start || 0,
                    parentFunctionNames: getParentFunctionNames(pathNode)
                });
                allNames.add(name);
            }
        },
        VariableDeclarator(pathNode) {
            const ids = pathNode.getBindingIdentifiers();
            for (const [name, idNode] of Object.entries(ids)) {
                bindings.set(name, {
                    type: 'var',
                    node: pathNode.node,
                    path: pathNode,
                    index: pathNode.node.start || 0,
                    parentFunctionNames: getParentFunctionNames(pathNode)
                });
                allNames.add(name);
            }
        }
    });
    const assignments = new Map();
    traverse(ast, {
        AssignmentExpression(pathNode) {
            if (t.isIdentifier(pathNode.node.left)) {
                const name = pathNode.node.left.name;
                if (allNames.has(name)) {
                    if (!assignments.has(name)) {
                        assignments.set(name, new Set());
                    }
                    const safeStmt = t.expressionStatement(t.cloneNode(pathNode.node));
                    assignments.get(name).add({
                        node: safeStmt,
                        right: pathNode.node.right,
                        path: pathNode,
                        index: pathNode.node.start || 0,
                        parentFunctionNames: getParentFunctionNames(pathNode)
                    });
                }
            }
        }
    });
    const dependencyGraph = new Map();
    const reversedGraph = new Map();
    for (const [name, binding] of bindings.entries()) {
        const nodeToScan = binding.node;
        if (nodeToScan) {
            const refs = getReferencedTopLevelNames(nodeToScan, allNames);
            reversedGraph.set(name, refs);
            for (const ref of refs) {
                if (!dependencyGraph.has(ref)) {
                    dependencyGraph.set(ref, new Set());
                }
                dependencyGraph.get(ref).add(name);
            }
        }
    }
    for (const [name, stmtSet] of assignments.entries()) {
        for (const stmt of stmtSet) {
            const refs = getReferencedTopLevelNames(stmt.right, allNames);
            if (name) {
                if (!reversedGraph.has(name)) {
                    reversedGraph.set(name, new Set());
                }
                for (const ref of refs) {
                    reversedGraph.get(name).add(ref);
                    if (!dependencyGraph.has(ref)) {
                        dependencyGraph.set(ref, new Set());
                    }
                    dependencyGraph.get(ref).add(name);
                }
            }
        }
    }
    const refCounts = new Map();
    traverse(ast, {
        Identifier(pathNode) {
            if (pathNode.isReferencedIdentifier()) {
                const name = pathNode.node.name;
                refCounts.set(name, (refCounts.get(name) || 0) + 1);
            }
        }
    });
    console.log("[+] Identifying retrieve function candidates...");
    const candidateCallees = new Set();
    const directlyValidated = new Set();
    traverse(ast, {
        FunctionDeclaration(pathNode) {
            if (matchesRetrievePattern(pathNode.node) && pathNode.node.id) {
                candidateCallees.add(pathNode.node.id.name);
            }
        }
    });
    let candidatesChanged = true;
    let scanPass = 0;
    while (candidatesChanged && scanPass < 10) {
        candidatesChanged = false;
        scanPass++;
        const oldSize = candidateCallees.size;
        traverse(ast, {
            CallExpression(pathNode) {
                if (t.isIdentifier(pathNode.node.callee)) {
                    const name = pathNode.node.callee.name;
                    const args = pathNode.node.arguments;
                    const hasBoilerplateArg = args.some(arg => t.isIdentifier(arg) && boilerplateDataVars.has(arg.name));
                    if (hasBoilerplateArg && !directlyValidated.has(name)) {
                        directlyValidated.add(name);
                        candidateCallees.add(name);
                        candidatesChanged = true;
                    }
                    if (args.length >= 1 && args.length <= 3 && !candidateCallees.has(name)) {
                        const allConstant = args.every(arg => isBoilerplateConstant(arg, boilerplateDataVars, candidateCallees));
                        if (allConstant) {
                            candidateCallees.add(name);
                            candidatesChanged = true;
                        }
                    }
                }
            }
        });
        if (candidateCallees.size > oldSize) {
            candidatesChanged = true;
        }
    }
    console.log(`[+] Candidate identification completed in ${scanPass} passes. Total candidates: ${candidateCallees.size}`);
    const retrieveFunctions = new Set(directlyValidated);
    for (const cand of candidateCallees) {
        if (retrieveFunctions.has(cand)) continue;
        if (!isBoilerplateHelper(cand, bindings)) continue;
        const candVisited = new Set();
        const candQueue = [cand];
        let connects = false;
        while (candQueue.length > 0) {
            const curr = candQueue.shift();
            if (boilerplateDataVars.has(curr)) {
                connects = true;
                break;
            }
            if (candVisited.has(curr)) continue;
            candVisited.add(curr);
            const deps = reversedGraph.get(curr);
            if (deps) {
                for (const dep of deps) {
                    if (!candVisited.has(dep)) {
                        candQueue.push(dep);
                    }
                }
            }
        }
        if (connects) {
            retrieveFunctions.add(cand);
        }
    }
    console.log("[+] Validated Retrieve Functions:", Array.from(retrieveFunctions));
    if (retrieveFunctions.size === 0) {
        console.warn("[-] Warning: No retrieve functions validated. Writing clean AST directly.");
        const output = generator(ast, {
            jsescOption: {
                minimal: true
            }
        });
        const cleanCode = beautify(output.code, {
            indent_size: 4
        });
        fs.writeFileSync(outputPath, cleanCode, 'utf8');
        return;
    }
    console.log("[+] Tracing all boilerplate dependencies top-down...");
    const visited = new Set();
    const sandboxNodesMap = new Map();
    const addedIndices = new Set();

    function trace(names) {
        const queue = Array.from(names);
        while (queue.length > 0) {
            const current = queue.shift();
            if (visited.has(current)) continue;
            visited.add(current);
            const binding = bindings.get(current);
            if (binding) {
                const isNested = binding.parentFunctionNames && binding.parentFunctionNames.some(name => visited.has(name));
                if (!isNested && !addedIndices.has(binding.index)) {
                    let stmtNode;
                    if (binding.type === 'var') {
                        let safeNode = t.cloneNode(binding.node);
                        const initPath = binding.path.get('init');
                        if (initPath && initPath.node && !isExpressionSafe(initPath, allNames, safeGlobals)) {
                            safeNode.init = null;
                        }
                        stmtNode = t.variableDeclaration('var', [safeNode]);
                    } else {
                        stmtNode = t.cloneNode(binding.node);
                    }
                    sandboxNodesMap.set(stmtNode, binding.index);
                    addedIndices.add(binding.index);
                }
            }
            const stmtSet = assignments.get(current);
            if (stmtSet) {
                stmtSet.forEach(stmt => {
                    const isNested = stmt.parentFunctionNames && stmt.parentFunctionNames.some(name => visited.has(name));
                    if (!isNested && !addedIndices.has(stmt.index)) {
                        const rightPath = stmt.path.get('right');
                        if (isExpressionSafe(rightPath, allNames, safeGlobals)) {
                            sandboxNodesMap.set(stmt.node, stmt.index);
                            addedIndices.add(stmt.index);
                        }
                    }
                });
            }
            const deps = reversedGraph.get(current);
            if (deps) {
                for (const dep of deps) {
                    if (!visited.has(dep)) {
                        queue.push(dep);
                    }
                }
            }
        }
    }
    trace(retrieveFunctions);
    let extended = true;
    while (extended) {
        extended = false;
        for (const cand of candidateCallees) {
            if (visited.has(cand)) continue;
            if (!isBoilerplateHelper(cand, bindings)) continue;
            const candVisited = new Set();
            const candQueue = [cand];
            let connects = false;
            while (candQueue.length > 0) {
                const curr = candQueue.shift();
                if (visited.has(curr) || boilerplateDataVars.has(curr)) {
                    connects = true;
                    break;
                }
                if (candVisited.has(curr)) continue;
                candVisited.add(curr);
                const deps = reversedGraph.get(curr);
                if (deps) {
                    for (const dep of deps) {
                        if (!candVisited.has(dep)) {
                            candQueue.push(dep);
                        }
                    }
                }
            }
            if (connects) {
                retrieveFunctions.add(cand);
                trace([cand]);
                extended = true;
            }
        }
    }
    console.log("[+] Traced Dependencies (Visited):", Array.from(visited));
    const sortedSandboxNodes = Array.from(sandboxNodesMap.entries()).map(([node, index]) => ({
        node,
        index
    })).sort((a, b) => a.index - b.index);
    const sandboxProgram = t.program(sortedSandboxNodes.map(s => t.cloneNode(s.node)));
    const {
        code: rawSandboxCode
    } = generator(sandboxProgram, {
        jsescOption: {
            minimal: true
        }
    });
    let injectPrefix = "";
    injectBindings.forEach(b => {
        injectPrefix += `var ${b.name} = ${b.code};\n`;
    });
    const sandboxCode = injectPrefix + rawSandboxCode;
    fs.writeFileSync('sandbox_debug.js', sandboxCode, 'utf8');
    console.log(`[+] Sandbox code size: ${sandboxCode.length} chars. Saved to sandbox_debug.js`);
    const sandbox = {
        console: console,
        TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
        TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : undefined,
        Buffer: typeof Buffer !== 'undefined' ? Buffer : undefined
    };
    sandbox.global = sandbox;
    sandbox.globalThis = sandbox;
    sandbox.window = sandbox;
    sandbox.document = {};
    vm.createContext(sandbox);
    const vmGlobals = {
        vmSymbol: vm.runInContext('Symbol', sandbox),
        vmString: vm.runInContext('String', sandbox),
        vmArray: vm.runInContext('Array', sandbox),
        vmUint8Array: vm.runInContext('Uint8Array', sandbox),
        vmTextDecoder: vm.runInContext('typeof TextDecoder !== "undefined" ? TextDecoder : undefined', sandbox),
        vmBuffer: vm.runInContext('typeof Buffer !== "undefined" ? Buffer : undefined', sandbox),
        vmObject: vm.runInContext('Object', sandbox),
        vmFunction: vm.runInContext('Function', sandbox),
        vmRegExp: vm.runInContext('RegExp', sandbox),
        vmDate: vm.runInContext('Date', sandbox),
        vmEval: vm.runInContext('eval', sandbox),
        vmMath: vm.runInContext('Math', sandbox),
        vmObjectKeys: vm.runInContext('Object.keys', sandbox),
        vmObjectDefineProperty: vm.runInContext('Object.defineProperty', sandbox),
        vmObjectGetOwnPropertyDescriptor: vm.runInContext('Object.getOwnPropertyDescriptor', sandbox),
        vmObjectAssign: vm.runInContext('Object.assign', sandbox),
        vmReflectOwnKeys: vm.runInContext('typeof Reflect !== "undefined" ? Reflect.ownKeys : undefined', sandbox),
        vmStringFromCharCode: vm.runInContext('String.fromCharCode', sandbox),
        vmStringFromCodePoint: vm.runInContext('String.fromCodePoint', sandbox),
        vmMathFloor: vm.runInContext('Math.floor', sandbox),
        vmMathAbs: vm.runInContext('Math.abs', sandbox),
        vmArrayIsArray: vm.runInContext('Array.isArray', sandbox),
        vmJSONStringify: vm.runInContext('JSON.stringify', sandbox),
        vmJSONParse: vm.runInContext('JSON.parse', sandbox),
        sandbox: sandbox,
        globalThis: vm.runInContext('globalThis', sandbox)
    };
    try {
        vm.runInContext(sandboxCode, sandbox);
        console.log("[+] Sandbox executed successfully!");
        console.log("[+] Filtering verified string decryptors dynamically...");
        const verifiedDecryptors = new Set();
        const testCalls = new Map();
        traverse(ast, {
            CallExpression(pathNode) {
                let callee = pathNode.node.callee;
                let rootIdentifier = null;
                if (t.isIdentifier(callee)) {
                    rootIdentifier = callee;
                } else if (t.isMemberExpression(callee)) {
                    let curr = callee;
                    while (t.isMemberExpression(curr)) {
                        curr = curr.object;
                    }
                    if (t.isIdentifier(curr)) {
                        rootIdentifier = curr;
                    }
                }
                if (rootIdentifier) {
                    const name = rootIdentifier.name;
                    if (visited.has(name)) {
                        const args = pathNode.node.arguments;
                        const isSimple = args.every(arg => isArgumentSafeForSandbox(arg, visited, safeGlobals));
                        if (isSimple) {
                            if (!testCalls.has(name)) {
                                testCalls.set(name, new Set());
                            }
                            try {
                                const {
                                    code
                                } = generator(pathNode.node);
                                testCalls.get(name).add(code);
                            } catch (e) {}
                        }
                    }
                }
            }
        });

        function performFiltering(minCalls) {
            const result = new Set();
            for (const name of visited) {
                const calls = testCalls.get(name);
                if (calls && calls.size >= minCalls) {
                    let isDecryptor = false;
                    for (const callCode of calls) {
                        try {
                            const val = vm.runInContext(callCode, sandbox, {
                                timeout: 50
                            });
                            if (val !== undefined && val !== null) {
                                isDecryptor = true;
                                break;
                            }
                        } catch (e) {}
                    }
                    if (isDecryptor) {
                        result.add(name);
                    }
                }
            }
            return result;
        }
        let filteredSet = performFiltering(3);
        if (filteredSet.size === 0) {
            console.log("[*] No decryptors found with threshold 3. Falling back to threshold 1...");
            filteredSet = performFiltering(1);
        }
        if (filteredSet.size > 0) {
            verifiedDecryptors.clear();
            for (const name of filteredSet) {
                verifiedDecryptors.add(name);
            }
            console.log("[+] Verified Decryptors:", Array.from(verifiedDecryptors));
            visited.clear();
            trace(verifiedDecryptors);
            console.log("[+] Re-traced Clean Visited Boilerplate size:", visited.size);
        } else {
            console.warn("[-] Warning: No verified decryptors found. Using fallback visited set.");
        }
        simplifyAST(ast, sandbox, visited, safeGlobals, vmGlobals);
        cleanBoilerplateDCE(ast, visited, reversedGraph);
        removeUnusedDeclarations(ast);
        console.log("[+] Generating final code...");
        const output = generator(ast, {
            jsescOption: {
                minimal: true
            }
        });
        const cleanCode = beautify(output.code, {
            indent_size: 4
        });
        fs.writeFileSync(outputPath, cleanCode, 'utf8');
        console.log(`[+] Deobfuscation completed successfully. Saved to: ${outputPath}\n`);
    } catch (sandboxErr) {
        console.error("[-] Sandbox execution error:", sandboxErr);
    }
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