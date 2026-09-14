const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generator = require('@babel/generator').default;

function getNumVal(node) {
    if (!node) return null;
    if (t.isNumericLiteral(node)) return node.value;
    if (t.isUnaryExpression(node) && node.operator === '-') {
        const val = getNumVal(node.argument);
        return val !== null ? -val : null;
    }
    if (t.isUnaryExpression(node) && node.operator === '+') {
        return getNumVal(node.argument);
    }
    return null;
}

function xorDecode(str, key) {
    let result = '';
    for (let i = 0; i < str.length; i++) {
        key = (key + 0x9e3779b9) | 0;
        const ks = (((key ^ (key >>> 13)) % 95) + 95) % 95;
        const normalized = str.charCodeAt(i) - 32;
        const shifted = (((normalized - ks) % 95) + 95) % 95;
        result += String.fromCharCode(shifted + 32);
    }
    return result;
}

function isStatesObject(node, statesVar) {
    if (!node || !statesVar) return false;
    if (typeof statesVar === 'string') {
        return t.isIdentifier(node, { name: statesVar });
    }
    return t.isNodesEquivalent(node, statesVar);
}

function evaluateExpr(node, states, statesVar, globalSeqMap = new Map()) {
    if (!node) return null;
    if (t.isNumericLiteral(node)) return node.value;
    if (t.isBooleanLiteral(node)) return node.value;

    if (t.isUnaryExpression(node)) {
        const arg = evaluateExpr(node.argument, states, statesVar, globalSeqMap);
        if (arg === null) return null;
        if (node.operator === '-') return -arg;
        if (node.operator === '+') return +arg;
        if (node.operator === '!') return !arg;
        if (node.operator === '~') return ~arg;
    }

    if (t.isBinaryExpression(node)) {
        const l = evaluateExpr(node.left, states, statesVar, globalSeqMap);
        const r = evaluateExpr(node.right, states, statesVar, globalSeqMap);
        if (l === null || r === null) return null;
        switch (node.operator) {
            case '+': return l + r;
            case '-': return l - r;
            case '*': return l * r;
            case '/': return l / r;
            case '%': return l % r;
            case '==': return l == r;
            case '===': return l === r;
            case '!=': return l != r;
            case '!==': return l !== r;
            case '<': return l < r;
            case '<=': return l <= r;
            case '>': return l > r;
            case '>=': return l >= r;
            case '^': return l ^ r;
            case '&': return l & r;
            case '|': return l | r;
            case '<<': return l << r;
            case '>>': return l >> r;
            case '>>>': return l >>> r;
        }
    }

    if (t.isLogicalExpression(node)) {
        const l = evaluateExpr(node.left, states, statesVar, globalSeqMap);
        if (node.operator === '&&') {
            if (l === false) return false;
            if (l === null) return null;
            return evaluateExpr(node.right, states, statesVar, globalSeqMap);
        }
        if (node.operator === '||') {
            if (l === true) return true;
            if (l === null) return null;
            return evaluateExpr(node.right, states, statesVar, globalSeqMap);
        }
    }

    if (t.isMemberExpression(node)) {
        if (isStatesObject(node.object, statesVar)) {
            const prop = evaluateExpr(node.property, states, statesVar, globalSeqMap);
            if (typeof prop === 'number' && states[prop] !== undefined) {
                return states[prop];
            }
        } else if (t.isIdentifier(node.object) && globalSeqMap.has(node.object.name)) {
            const seq = globalSeqMap.get(node.object.name);
            const prop = evaluateExpr(node.property, states, statesVar, globalSeqMap);
            if (typeof prop === 'number' && prop >= 0 && prop < seq.length) {
                return seq[prop];
            }
        }
    }

    return null;
}

function isTargetOfAssignmentOrPattern(p) {
    if (!p || !p.parentPath) return false;
    if (p.parentPath.isAssignmentExpression() && p.parentKey === 'left') return true;
    if (p.parentPath.isUpdateExpression() && p.parentKey === 'argument') return true;
    if (p.parentPath.isRestElement()) return true;

    let curr = p;
    while (curr && curr.parentPath) {
        const parent = curr.parentPath;
        if (parent.isAssignmentPattern()) {
            if (curr.parentKey === 'left') {
                curr = parent;
                continue;
            } else {
                break;
            }
        }
        if (parent.isArrayPattern() || parent.isObjectPattern() || parent.isRestElement() ||
            (parent.isObjectProperty() && curr.parentKey === 'value')) {
            curr = parent;
            continue;
        }
        if (parent.isAssignmentExpression() && curr.parentKey === 'left') {
            return true;
        }
        if (parent.isVariableDeclarator() && curr.parentKey === 'id') {
            return true;
        }
        break;
    }
    return false;
}

function simplifyStatesInNode(node, states, statesVar, xorFnMap, stringsMap) {
    if (!node) return;
    const prog = t.isStatement(node)
        ? t.program([t.cloneNode(node)])
        : t.program([t.expressionStatement(t.cloneNode(node))]);

    traverse(prog, {
        noScope: true,
        enter(p) {
            if (p.isFunction()) { p.skip(); return; }
            // Guard: assignment target, update argument, rest element, or nested destructuring pattern
            if (isTargetOfAssignmentOrPattern(p)) return;

            // Check for XOR string decoder calls: xorFn(key, start, len)
            if (t.isCallExpression(p.node) && t.isIdentifier(p.node.callee) && xorFnMap && xorFnMap.has(p.node.callee.name)) {
                const mapVal = xorFnMap.get(p.node.callee.name);
                const strVal = typeof mapVal === 'string' && (!stringsMap || !stringsMap.has(mapVal))
                    ? mapVal
                    : (stringsMap && stringsMap.get(mapVal));
                if (strVal && p.node.arguments.length >= 3) {
                    const keyVal = evaluateExpr(p.node.arguments[0], states, statesVar);
                    const startVal = evaluateExpr(p.node.arguments[1], states, statesVar);
                    const lenVal = evaluateExpr(p.node.arguments[2], states, statesVar);
                    if (keyVal !== null && startVal !== null && lenVal !== null &&
                        lenVal > 0 && startVal >= 0 && startVal + lenVal <= strVal.length) {
                        const sliceStr = strVal.slice(startVal, startVal + lenVal);
                        const decoded = xorDecode(sliceStr, keyVal);
                        p.replaceWith(t.stringLiteral(decoded));
                        p.skip();
                        return;
                    }
                }
            }

            // Member expression on states
            if (t.isMemberExpression(p.node) && isStatesObject(p.node.object, statesVar)) {
                const val = evaluateExpr(p.node, states, statesVar);
                if (typeof val === 'number') {
                    p.replaceWith(t.valueToNode(val));
                    p.skip();
                    return;
                }
            }

            // Binary / Unary expressions depending only on states
            if (t.isBinaryExpression(p.node) || t.isUnaryExpression(p.node)) {
                const val = evaluateExpr(p.node, states, statesVar);
                if (val !== null && typeof val === 'number') {
                    p.replaceWith(t.valueToNode(val));
                    p.skip();
                } else if (val !== null && typeof val === 'boolean') {
                    p.replaceWith(t.booleanLiteral(val));
                    p.skip();
                }
            }
        }
    });

    if (t.isStatement(node)) {
        Object.assign(node, prog.body[0]);
    } else {
        Object.assign(node, prog.body[0].expression);
    }
}

function unwrapCFF(ast) {
    let changed = false;

    traverse(ast, {
        Program(p) {
            p.scope.crawl();
        }
    });

    // 1. Scan global CFF resources (sequences, slice functions, sum functions, xor string tables)
    const sequences = new Map(); // sequenceName -> number[]
    const sliceFunctions = new Map(); // sliceFnName -> sequenceName
    const sumFunctions = new Set(); // sumFnName
    const xorFunctions = new Map(); // xorFnName -> stringsVarName or stringValue
    const stringsMap = new Map(); // stringsVarName -> stringValue

    traverse(ast, {
        VariableDeclarator(path) {
            // Find sequence array: var seq = [num, num, ...];
            if (t.isIdentifier(path.node.id) && t.isArrayExpression(path.node.init)) {
                const elements = path.node.init.elements;
                if (elements.length >= 20 && elements.every(el => el !== null && getNumVal(el) !== null)) {
                    const nums = elements.map(el => getNumVal(el));
                    sequences.set(path.node.id.name, nums);
                }
            }
            // Find strings value: var strVar = "printable ascii...";
            if (t.isIdentifier(path.node.id) && t.isStringLiteral(path.node.init) && path.node.init.value.length >= 20) {
                const ex = stringsMap.get(path.node.id.name);
                if (!ex || path.node.init.value.length > ex.length) {
                    stringsMap.set(path.node.id.name, path.node.init.value);
                }
            }
        },
        FunctionDeclaration(path) {
            if (!path.node.id) return;
            const fnName = path.node.id.name;
            const bodyCode = generator(path.node.body).code;

            // sum function: for (var sum = 0, i = 0; i < array.length; i++) sum += array[i]; return sum;
            if ((bodyCode.includes('["length"]') || bodyCode.includes('.length')) &&
                (bodyCode.includes('sum +=') || bodyCode.includes('+=') && bodyCode.includes('return'))) {
                sumFunctions.add(fnName);
            }

            // slice function: return sequence["slice"](min, max);
            if (bodyCode.includes('["slice"]') || bodyCode.includes('.slice(')) {
                path.traverse({
                    CallExpression(callPath) {
                        const callee = callPath.node.callee;
                        if (t.isMemberExpression(callee) && t.isIdentifier(callee.object)) {
                            const isSlice = (t.isStringLiteral(callee.property) && callee.property.value === 'slice') ||
                                            (!callee.computed && t.isIdentifier(callee.property, { name: 'slice' }));
                            if (isSlice) {
                                sliceFunctions.set(fnName, callee.object.name);
                            }
                        }
                    }
                });
            }

            // xor decode function: position-based cipher with 0x9e3779b9
            if (bodyCode.includes('0x9e3779b9') || bodyCode.includes('2654435769')) {
                path.traverse({
                    MemberExpression(mPath) {
                        if (t.isIdentifier(mPath.node.object)) {
                            const b = mPath.scope.getBinding(mPath.node.object.name);
                            if (b && b.path && b.path.isVariableDeclarator() && t.isStringLiteral(b.path.node.init)) {
                                xorFunctions.set(fnName, b.path.node.init.value);
                            } else if (stringsMap.has(mPath.node.object.name)) {
                                xorFunctions.set(fnName, stringsMap.get(mPath.node.object.name));
                            }
                        }
                    }
                });
            }
        }
    });

    if (sumFunctions.size === 0) return false;

    // Helper: evaluate ArrayExpression to number[] using sequences and sliceFunctions
    function evalArrayElements(arrNode) {
        if (!t.isArrayExpression(arrNode)) return null;
        const res = [];
        for (const el of arrNode.elements) {
            if (!el) return null;
            const num = getNumVal(el);
            if (num !== null) {
                res.push(num);
            } else if (t.isSpreadElement(el)) {
                const call = el.argument;
                if (t.isCallExpression(call) && t.isIdentifier(call.callee) && sliceFunctions.has(call.callee.name)) {
                    const seqName = sliceFunctions.get(call.callee.name);
                    const seq = sequences.get(seqName);
                    if (!seq || call.arguments.length < 2) return null;
                    const start = getNumVal(call.arguments[0]);
                    const end = getNumVal(call.arguments[1]);
                    if (start === null || end === null) return null;
                    res.push(...seq.slice(start, end));
                } else {
                    return null;
                }
            } else {
                return null;
            }
        }
        return res;
    }

    // 2. Locate all CFF WhileStatements that belong to a flattened function
    const cffWhileCandidates = [];

    traverse(ast, {
        WhileStatement(path) {
            const test = path.node.test;
            if (!t.isBinaryExpression(test) || (test.operator !== '!==' && test.operator !== '!=')) {
                return;
            }

            let call = null;
            let endState = null;
            if (t.isCallExpression(test.left) && t.isIdentifier(test.left.callee) && sumFunctions.has(test.left.callee.name)) {
                call = test.left;
                endState = getNumVal(test.right);
            } else if (t.isCallExpression(test.right) && t.isIdentifier(test.right.callee) && sumFunctions.has(test.right.callee.name)) {
                call = test.right;
                endState = getNumVal(test.left);
            }

            if (!call || endState === null || call.arguments.length < 1) {
                return;
            }

            const sumFnName = call.callee.name;
            const statesVarNode = call.arguments[0];

            const enclosingFn = path.getFunctionParent();
            if (!enclosingFn || !enclosingFn.isFunctionDeclaration()) return;
            if (enclosingFn.node.params.length < 1 || !isStatesObject(enclosingFn.node.params[0], statesVarNode)) return;

            // Check body for SwitchStatement matching sumFnName and statesVarNode
            let switchNode = null;
            let switchLabel = null;
            path.traverse({
                SwitchStatement(sPath) {
                    if (sPath.getFunctionParent() !== enclosingFn) return;
                    if (!switchNode && t.isCallExpression(sPath.node.discriminant) &&
                        t.isIdentifier(sPath.node.discriminant.callee, { name: sumFnName }) &&
                        isStatesObject(sPath.node.discriminant.arguments[0], statesVarNode)) {
                        switchNode = sPath.node;
                        if (sPath.parentPath.isLabeledStatement()) {
                            switchLabel = sPath.parentPath.node.label.name;
                        }
                    }
                }
            });

            if (!switchNode) return;

            cffWhileCandidates.push({
                whilePath: path,
                enclosingFn,
                sumFnName,
                statesVarNode,
                endState,
                switchNode,
                switchLabel
            });
        }
    });

    if (cffWhileCandidates.length === 0) return false;

    // 3. Process each candidate
    for (const candidate of cffWhileCandidates) {
        try {
            const { whilePath, enclosingFn, sumFnName, statesVarNode: origStatesVarNode, endState, switchNode } = candidate;
            const mainFnName = enclosingFn.node.id.name;

            // Scope-isolated call references lookup
            const binding = enclosingFn.parentPath.scope.getBinding(mainFnName);
            if (!binding) continue;

            const externalCalls = binding.referencePaths
                .filter(r => r.parentPath && r.parentPath.isCallExpression() && r.parentPath.node.callee === r.node && !r.findParent(p => p === enclosingFn))
                .map(r => r.parentPath);

            if (externalCalls.length === 0) continue;

            let statesVarNode = origStatesVarNode;

            // Group switch cases into basic blocks
            const basicBlocks = [];
            let pendingTests = [];
            for (const sc of switchNode.cases) {
                pendingTests.push(sc.test);
                if (sc.consequent && sc.consequent.length > 0) {
                    basicBlocks.push({
                        tests: pendingTests,
                        statements: sc.consequent
                    });
                    pendingTests = [];
                }
            }

            if (basicBlocks.length === 0) continue;

            function findBlock(st) {
                const sumVal = st.reduce((a, b) => a + b, 0);
                for (const bb of basicBlocks) {
                    for (const test of bb.tests) {
                        if (evaluateExpr(test, st, statesVarNode, sequences) === sumVal) {
                            return bb;
                        }
                    }
                }
                return null;
            }

            function applyStateAssignments(st, stmts) {
                for (const stmt of stmts) {
                    if (t.isExpressionStatement(stmt)) {
                        let exprs = [stmt.expression];
                        if (t.isSequenceExpression(stmt.expression)) {
                            exprs = stmt.expression.expressions;
                        }
                        for (const expr of exprs) {
                            if (t.isAssignmentExpression(expr) && t.isMemberExpression(expr.left) &&
                                isStatesObject(expr.left.object, statesVarNode)) {
                                const leftIdx = evaluateExpr(expr.left.property, st, statesVarNode, sequences);
                                const rightVal = evaluateExpr(expr.right, st, statesVarNode, sequences);
                                if (leftIdx !== null && rightVal !== null) {
                                    if (expr.operator === '+=') st[leftIdx] += rightVal;
                                    else if (expr.operator === '-=') st[leftIdx] -= rightVal;
                                    else if (expr.operator === '=') st[leftIdx] = rightVal;
                                } else {
                                    throw new Error("Dynamic state transition cannot be determined");
                                }
                            } else if (t.isUpdateExpression(expr) && t.isMemberExpression(expr.argument) &&
                                       isStatesObject(expr.argument.object, statesVarNode)) {
                                const leftIdx = evaluateExpr(expr.argument.property, st, statesVarNode, sequences);
                                if (leftIdx !== null && st[leftIdx] !== undefined) {
                                    if (expr.operator === '++') st[leftIdx]++;
                                    else if (expr.operator === '--') st[leftIdx]--;
                                } else {
                                    throw new Error("Dynamic state update cannot be determined");
                                }
                            }
                        }
                    }
                }
            }

            // Trace state machine execution
            let totalSteps = 0;
            function traceFlow(st, depth = 0, stopAtSum = null, visited = new Set()) {
                if (++totalSteps > 500) {
                    throw new Error("CFF trace total steps exceeded limit");
                }
                if (depth > 200) {
                    throw new Error("CFF trace recursion depth exceeded limit");
                }

                const currentSum = st.reduce((a, b) => a + b, 0);
                if (currentSum === endState || (stopAtSum !== null && currentSum === stopAtSum)) {
                    return [];
                }

                const stateSig = `${currentSum}:${st.join(',')}`;
                if (visited.has(stateSig)) {
                    throw new Error(`Cycle detected at state sum ${currentSum}`);
                }
                const nextVisited = new Set(visited);
                nextVisited.add(stateSig);

                const bb = findBlock(st);
                if (!bb) {
                    throw new Error(`No matching basic block for state sum ${currentSum}`);
                }

                const emitted = [];
                const transitions = [];
                let ifStmt = null;
                let retStmt = null;

                for (const s of bb.statements) {
                    if (t.isReturnStatement(s)) {
                        retStmt = s;
                        break;
                    } else if (t.isIfStatement(s)) {
                        const condVal = evaluateExpr(s.test, st, statesVarNode, sequences);
                        if (condVal === false) {
                            // Opaque false predicate / fake jump -> eliminate!
                            continue;
                        } else if (condVal === true) {
                            // Always true -> execute consequent state assignments
                            applyStateAssignments(st, s.consequent.body || [s.consequent]);
                            break;
                        } else if (t.isMemberExpression(s.test)) {
                            // Scope assertion predicate: take consequent
                            applyStateAssignments(st, s.consequent.body || [s.consequent]);
                            break;
                        } else {
                            // Check if this is an early return guard with no alternate
                            const consStmts = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
                            const isGuardReturn = !s.alternate && consStmts.some(x => t.isReturnStatement(x));
                            if (isGuardReturn) {
                                const clonedGuard = t.cloneNode(s);
                                simplifyStatesInNode(clonedGuard, st, statesVarNode, xorFunctions, stringsMap);
                                emitted.push(clonedGuard);
                                continue;
                            }
                            // Real user If statement
                            ifStmt = s;
                            break;
                        }
                    } else if (t.isBreakStatement(s)) {
                        break;
                    } else if (t.isExpressionStatement(s) && (
                        (t.isAssignmentExpression(s.expression) && t.isMemberExpression(s.expression.left) && isStatesObject(s.expression.left.object, statesVarNode)) ||
                        (t.isUpdateExpression(s.expression) && t.isMemberExpression(s.expression.argument) && isStatesObject(s.expression.argument.object, statesVarNode)) ||
                        (t.isSequenceExpression(s.expression) && s.expression.expressions.some(e => 
                            (t.isAssignmentExpression(e) && t.isMemberExpression(e.left) && isStatesObject(e.left.object, statesVarNode)) ||
                            (t.isUpdateExpression(e) && t.isMemberExpression(e.argument) && isStatesObject(e.argument.object, statesVarNode))
                        ))
                    )) {
                        transitions.push(s);
                    } else {
                        const cloned = t.cloneNode(s);
                        simplifyStatesInNode(cloned, st, statesVarNode, xorFunctions, stringsMap);
                        emitted.push(cloned);
                    }
                }

                if (retStmt) {
                    const clonedRet = t.cloneNode(retStmt);
                    if (t.isSequenceExpression(clonedRet.argument)) {
                        const exprs = clonedRet.argument.expressions;
                        clonedRet.argument = exprs[exprs.length - 1];
                    }
                    simplifyStatesInNode(clonedRet, st, statesVarNode, xorFunctions, stringsMap);
                    emitted.push(clonedRet);
                    return emitted;
                }

                if (ifStmt) {
                    const st1 = [...st];
                    applyStateAssignments(st1, ifStmt.consequent.body || [ifStmt.consequent]);
                    const targetSum1 = st1.reduce((a, b) => a + b, 0);

                    const st2 = [...st];
                    if (ifStmt.alternate) {
                        applyStateAssignments(st2, ifStmt.alternate.body || [ifStmt.alternate]);
                    } else {
                        const sIndex = bb.statements.indexOf(ifStmt);
                        const trailing = sIndex !== -1 ? bb.statements.slice(sIndex + 1) : [];
                        if (trailing.length > 0) {
                            applyStateAssignments(st2, trailing);
                        }
                    }
                    const targetSum2 = st2.reduce((a, b) => a + b, 0);

                    // Find join sum if both branches converge
                    function getPathSums(startSt) {
                        const sums = [];
                        const curr = [...startSt];
                        for (let i = 0; i < 40; i++) {
                            const s = curr.reduce((a, b) => a + b, 0);
                            sums.push(s);
                            if (s === endState) break;
                            const b = findBlock(curr);
                            if (!b) break;
                            if (b.statements.some(x => t.isReturnStatement(x))) break;
                            if (b.statements.some(x => t.isIfStatement(x) && evaluateExpr(x.test, curr, statesVarNode, sequences) === null)) break;
                            applyStateAssignments(curr, b.statements);
                        }
                        return sums;
                    }

                    const path1Sums = getPathSums(st1);
                    const path2Sums = getPathSums(st2);
                    let joinSum = null;
                    for (const s of path1Sums) {
                        if (path2Sums.includes(s) && s !== targetSum1 && s !== targetSum2) {
                            joinSum = s;
                            break;
                        }
                    }

                    const condCloned = t.cloneNode(ifStmt.test);
                    simplifyStatesInNode(condCloned, st, statesVarNode, xorFunctions, stringsMap);

                    const branch1Stmts = traceFlow(st1, depth + 1, joinSum, nextVisited);
                    const branch2Stmts = traceFlow(st2, depth + 1, joinSum, nextVisited);

                    emitted.push(t.ifStatement(
                        condCloned,
                        t.blockStatement(branch1Stmts),
                        branch2Stmts.length > 0 ? t.blockStatement(branch2Stmts) : null
                    ));

                    if (joinSum !== null && joinSum !== endState) {
                        const joinSt = [...st1];
                        while (joinSt.reduce((a, b) => a + b, 0) !== joinSum) {
                            const b = findBlock(joinSt);
                            applyStateAssignments(joinSt, b.statements);
                        }
                        const afterStmts = traceFlow(joinSt, depth + 1, stopAtSum, nextVisited);
                        emitted.push(...afterStmts);
                    }
                    return emitted;
                }

                // Unconditional transition
                applyStateAssignments(st, transitions);
                const nextStmts = traceFlow(st, depth + 1, stopAtSum, nextVisited);
                emitted.push(...nextStmts);
                return emitted;
            }

            let allSucceeded = true;
            const replacements = [];

            for (const callPath of externalCalls) {
                const arg0 = callPath.node.arguments[0];
                const initStates = evalArrayElements(arg0);
                if (!initStates) {
                    allSucceeded = false;
                    break;
                }

                try {
                    const reconstructed = traceFlow([...initStates]);
                    const prepends = [];
                    const paramMap = new Map();
                    for (let pi = 1; pi < enclosingFn.node.params.length; pi++) {
                        const param = enclosingFn.node.params[pi];
                        const paramId = t.isAssignmentPattern(param) ? param.left : param;
                        let initVal = null;
                        if (pi < callPath.node.arguments.length) {
                            initVal = callPath.node.arguments[pi];
                            if (t.isIdentifier(initVal) && !callPath.scope.hasBinding(initVal.name)) {
                                initVal = t.unaryExpression('void', t.numericLiteral(0));
                            }
                        } else if (t.isAssignmentPattern(param)) {
                            initVal = param.right;
                        }
                        if (initVal && t.isIdentifier(paramId)) {
                            const localId = callPath.scope.generateUidIdentifier(paramId.name);
                            paramMap.set(paramId.name, localId);
                            prepends.push(t.variableDeclaration('var', [
                                t.variableDeclarator(localId, t.cloneNode(initVal))
                            ]));
                        }
                    }

                    if (paramMap.size > 0) {
                        const dummyProg = t.program(reconstructed);
                        traverse(dummyProg, {
                            noScope: true,
                            Identifier(idPath) {
                                if (paramMap.has(idPath.node.name)) {
                                    if (idPath.parentPath.isMemberExpression() && idPath.parentPath.node.property === idPath.node && !idPath.parentPath.node.computed) {
                                        return;
                                    }
                                    if (idPath.parentPath.isObjectProperty() && idPath.parentPath.node.key === idPath.node && !idPath.parentPath.node.computed) {
                                        return;
                                    }
                                    idPath.replaceWith(t.cloneNode(paramMap.get(idPath.node.name)));
                                }
                            }
                        });
                    }

                    replacements.push({
                        callPath,
                        reconstructed: [...prepends, ...reconstructed]
                    });
                } catch (err) {
                    allSucceeded = false;
                    break;
                }
            }

            if (!allSucceeded || replacements.length === 0) continue;

            // Apply replacements
            for (const { callPath, reconstructed } of replacements) {
                // Check if call is in a return: return mainFn(states, ...);
                if (callPath.parentPath.isReturnStatement()) {
                    const fnParent = callPath.getFunctionParent();
                    if (fnParent && !fnParent.findParent(p => p === enclosingFn) && fnParent !== enclosingFn) {
                        if (fnParent.node.body && t.isBlockStatement(fnParent.node.body) && fnParent.node.body.body.length === 1) {
                            // Restore parameters if first statement unpacked from arguments
                            if (reconstructed.length > 0) {
                                const first = reconstructed[0];
                                if (t.isVariableDeclaration(first) && first.declarations.length === 1 &&
                                    t.isArrayPattern(first.declarations[0].id)) {
                                    const pattern = first.declarations[0].id;
                                    fnParent.node.params = pattern.elements.map(el => t.cloneNode(el));
                                    reconstructed.shift();
                                }
                            }
                            fnParent.node.body = t.blockStatement(reconstructed);
                            changed = true;
                            continue;
                        }
                    }
                }

                // Check if call is in a statement block, possibly followed by if (didReturn) return result;
                let stmtPath = callPath.getStatementParent();
                if (stmtPath && stmtPath.parentPath && stmtPath.parentPath.isBlock()) {
                    const blockBody = stmtPath.parentPath.node.body;
                    const idx = blockBody.indexOf(stmtPath.node);
                    if (idx !== -1) {
                        // Check if following statement is if (didReturn) return result;
                        let countToRemove = 1;
                        let isReturnIf = false;
                        if (idx + 1 < blockBody.length) {
                            const next = blockBody[idx + 1];
                            if (t.isIfStatement(next) && !next.alternate && (
                                t.isReturnStatement(next.consequent) ||
                                (t.isBlockStatement(next.consequent) && next.consequent.body.length === 1 && t.isReturnStatement(next.consequent.body[0]))
                            )) {
                                isReturnIf = true;
                                countToRemove = 2;
                            }
                        }

                        // Determine if stmtPath is an expression statement or variable declaration that contains callPath
                        const isStandalone = stmtPath.isExpressionStatement() && (
                            stmtPath.node.expression === callPath.node ||
                            (t.isSequenceExpression(stmtPath.node.expression) &&
                             stmtPath.node.expression.expressions[stmtPath.node.expression.expressions.length - 1] === callPath.node)
                        );

                        const isAssignOrVar = (stmtPath.isExpressionStatement() && (
                            (t.isAssignmentExpression(stmtPath.node.expression) && (
                                stmtPath.node.expression.right === callPath.node ||
                                (t.isSequenceExpression(stmtPath.node.expression.right) &&
                                 stmtPath.node.expression.right.expressions[stmtPath.node.expression.right.expressions.length - 1] === callPath.node)
                            )) ||
                            (t.isSequenceExpression(stmtPath.node.expression) && (
                                stmtPath.node.expression.expressions.some(e =>
                                    e === callPath.node ||
                                    (t.isAssignmentExpression(e) && e.right === callPath.node)
                                )
                            ))
                        )) || (stmtPath.isVariableDeclaration() && stmtPath.node.declarations.some(d => d.init === callPath.node));

                        const hasReturn = reconstructed.some(s => t.isReturnStatement(s));
                        const isTopLevelProgram = stmtPath.parentPath.isProgram();

                        if ((!isTopLevelProgram || !hasReturn) && ((isReturnIf && (isStandalone || isAssignOrVar)) || (isStandalone && !isReturnIf))) {
                            let startIdx = idx;
                            // Check if preceding statement is didReturn = void 0;
                            if (isReturnIf && idx - 1 >= 0) {
                                const prev = blockBody[idx - 1];
                                if (t.isExpressionStatement(prev) && t.isAssignmentExpression(prev.expression) &&
                                    t.isIdentifier(prev.expression.left) && (
                                        (t.isUnaryExpression(prev.expression.right) && prev.expression.right.operator === 'void') ||
                                        t.isIdentifier(prev.expression.right, { name: 'undefined' })
                                    )) {
                                    startIdx = idx - 1;
                                    countToRemove++;
                                }
                            }
                            blockBody.splice(startIdx, countToRemove, ...reconstructed);
                            changed = true;
                            continue;
                        }
                    }
                }

                // Fallback: replace callPath with a self-invoking function containing reconstructed statements
                const iife = t.callExpression(
                    t.functionExpression(null, [], t.blockStatement(reconstructed)),
                    []
                );
                callPath.replaceWith(iife);
                changed = true;
            }

            // Remove mainFn declaration if all calls were replaced
            try {
                enclosingFn.parentPath.scope.crawl();
                const updatedBinding = enclosingFn.parentPath.scope.getBinding(mainFnName);
                if (!updatedBinding || updatedBinding.referencePaths.length === 0) {
                    enclosingFn.remove();
                    changed = true;
                }
            } catch (e) {}
        } catch (candErr) {
            // Safety: Skip failing candidate without breaking pipeline
        }
    }

    return changed;
}

module.exports = {
    unwrapCFF
};
