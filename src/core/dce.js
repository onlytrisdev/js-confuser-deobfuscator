const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const RESERVED_WORDS = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function',
    'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch',
    'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
    'let', 'static', 'enum', 'await', 'implements', 'package', 'protected',
    'interface', 'private', 'public', 'null', 'true', 'false'
]);

function isValidIdentifier(name) {
    return /^[$A-Z_][0-9A-Z_$]*$/i.test(name) && !RESERVED_WORDS.has(name);
}

function isBodyFreeOfExternalSideEffects(fnNode, topLevelFns = null, programVars = null, mutatedProgramVars = null, visitedFns = new Set()) {
    let safe = true;
    const localNames = new Set();
    if (fnNode.id && t.isIdentifier(fnNode.id)) {
        localNames.add(fnNode.id.name);
        visitedFns.add(fnNode.id.name);
    }
    if (Array.isArray(fnNode.params)) {
        for (const p of fnNode.params) {
            if (t.isIdentifier(p)) localNames.add(p.name);
            else if (t.isAssignmentPattern(p) && t.isIdentifier(p.left)) localNames.add(p.left.name);
            else if (t.isRestElement(p) && t.isIdentifier(p.argument)) localNames.add(p.argument.name);
        }
    }
    traverse(fnNode.body, {
        noScope: true,
        Function(p) {
            p.skip();
        },
        VariableDeclarator(p) {
            if (t.isIdentifier(p.node.id)) localNames.add(p.node.id.name);
        },
        FunctionDeclaration(p) {
            if (p.node.id && t.isIdentifier(p.node.id)) localNames.add(p.node.id.name);
        }
    });

    const isAllowedTarget = (name) => {
        if (localNames.has(name)) return true;
        if (programVars && programVars.has(name)) {
            if (mutatedProgramVars) mutatedProgramVars.add(name);
            return true;
        }
        return false;
    };

    traverse(fnNode.body, {
        noScope: true,
        Function(p) {
            p.skip();
        },
        Identifier(p) {
            if (p.node.name === 'console') {
                safe = false;
                p.stop();
            }
        },
        AssignmentExpression(p) {
            const left = p.node.left;
            if (t.isIdentifier(left)) {
                if (!isAllowedTarget(left.name)) {
                    safe = false;
                    p.stop();
                }
            } else if (t.isMemberExpression(left)) {
                if (!t.isIdentifier(left.object) || !isAllowedTarget(left.object.name)) {
                    safe = false;
                    p.stop();
                }
            } else {
                safe = false;
                p.stop();
            }
        },
        UpdateExpression(p) {
            const arg = p.node.argument;
            if (t.isIdentifier(arg)) {
                if (!isAllowedTarget(arg.name)) {
                    safe = false;
                    p.stop();
                }
            } else if (t.isMemberExpression(arg)) {
                if (!t.isIdentifier(arg.object) || !isAllowedTarget(arg.object.name)) {
                    safe = false;
                    p.stop();
                }
            } else {
                safe = false;
                p.stop();
            }
        },
        NewExpression(p) {
            if (t.isIdentifier(p.node.callee) && (
                ['Array', 'Object', 'RegExp', 'Date', 'Map', 'Set', 'Error', 'TypeError', 'RangeError', 'Uint8Array'].includes(p.node.callee.name) ||
                (programVars && programVars.has(p.node.callee.name))
            )) {
                return;
            }
            safe = false;
            p.stop();
        },
        CallExpression(p) {
            const callee = p.node.callee;
            if (t.isIdentifier(callee)) {
                if (localNames.has(callee.name) || ['String', 'Number', 'Boolean', 'Array', 'Object', 'parseInt', 'parseFloat', 'isNaN', 'isFinite', 'decodeURIComponent', 'encodeURIComponent', 'unescape', 'escape'].includes(callee.name)) {
                    return;
                }
                if (topLevelFns && topLevelFns.has(callee.name)) {
                    if (visitedFns.has(callee.name)) {
                        return;
                    }
                    const targetFn = topLevelFns.get(callee.name);
                    if (isBodyFreeOfExternalSideEffects(targetFn, topLevelFns, programVars, mutatedProgramVars, visitedFns)) {
                        return;
                    }
                }
                safe = false;
                p.stop();
                return;
            }
            if (t.isMemberExpression(callee)) {
                const propName = !callee.computed && t.isIdentifier(callee.property)
                    ? callee.property.name
                    : (callee.computed && t.isStringLiteral(callee.property) ? callee.property.value : null);
                if (t.isIdentifier(callee.object)) {
                    if (localNames.has(callee.object.name)) {
                        return;
                    }
                    if (callee.object.name === 'Math' || callee.object.name === 'Number' || callee.object.name === 'JSON') return;
                    if (callee.object.name === 'String' && ['fromCharCode', 'fromCodePoint', 'raw'].includes(propName)) return;
                    if (callee.object.name === 'Object' && ['create', 'keys', 'values', 'entries', 'freeze', 'getOwnPropertyDescriptor', 'getOwnPropertyNames', 'getPrototypeOf', 'defineProperty', 'assign'].includes(propName)) return;
                    if (callee.object.name === 'Array' && ['isArray', 'from', 'of'].includes(propName)) return;
                }
                if (propName && ['slice', 'charCodeAt', 'codePointAt', 'charAt', 'indexOf', 'includes', 'join', 'concat', 'toString', 'valueOf', 'substring', 'substr', 'split', 'replace', 'trim', 'toLowerCase', 'toUpperCase', 'bind', 'call', 'apply', 'push', 'pop', 'shift', 'unshift', 'reverse', 'sort'].includes(propName)) {
                    if (['push', 'pop', 'shift', 'unshift', 'reverse', 'sort'].includes(propName)) {
                        if (t.isIdentifier(callee.object) && isAllowedTarget(callee.object.name)) {
                            return;
                        }
                        safe = false;
                        p.stop();
                        return;
                    }
                    return;
                }
                safe = false;
                p.stop();
                return;
            }
            if (!t.isFunctionExpression(callee) && !t.isArrowFunctionExpression(callee)) {
                safe = false;
                p.stop();
            }
        }
    });
    return safe;
}

function isPureOrRemovableExpr(node, topLevelFns, programVars = null, mutatedProgramVars = null) {
    if (!node) return true;
    if (t.isLiteral(node)) return true;
    if (t.isIdentifier(node)) return true;
    if (t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) return true;
    if (t.isArrayExpression(node)) {
        return node.elements.every(el => !el || (!t.isSpreadElement(el) && isPureOrRemovableExpr(el, topLevelFns, programVars, mutatedProgramVars)));
    }
    if (t.isObjectExpression(node)) {
        return node.properties.every(prop => {
            if (t.isObjectProperty(prop)) {
                const keyOk = !prop.computed || isPureOrRemovableExpr(prop.key, topLevelFns, programVars, mutatedProgramVars);
                return keyOk && isPureOrRemovableExpr(prop.value, topLevelFns, programVars, mutatedProgramVars);
            }
            return t.isObjectMethod(prop);
        });
    }
    if (t.isUnaryExpression(node)) {
        if (node.operator === 'delete') return false;
        return isPureOrRemovableExpr(node.argument, topLevelFns, programVars, mutatedProgramVars);
    }
    if (t.isBinaryExpression(node) || t.isLogicalExpression(node)) {
        return isPureOrRemovableExpr(node.left, topLevelFns, programVars, mutatedProgramVars) && isPureOrRemovableExpr(node.right, topLevelFns, programVars, mutatedProgramVars);
    }
    if (t.isConditionalExpression(node)) {
        return isPureOrRemovableExpr(node.test, topLevelFns, programVars, mutatedProgramVars) &&
            isPureOrRemovableExpr(node.consequent, topLevelFns, programVars, mutatedProgramVars) &&
            isPureOrRemovableExpr(node.alternate, topLevelFns, programVars, mutatedProgramVars);
    }
    if (t.isMemberExpression(node)) {
        const objOk = isPureOrRemovableExpr(node.object, topLevelFns, programVars, mutatedProgramVars);
        const propOk = !node.computed || isPureOrRemovableExpr(node.property, topLevelFns, programVars, mutatedProgramVars);
        return objOk && propOk;
    }
    if (t.isSequenceExpression(node)) {
        return node.expressions.every(e => isPureOrRemovableExpr(e, topLevelFns, programVars, mutatedProgramVars));
    }
    if (t.isNewExpression(node)) {
        if (t.isIdentifier(node.callee) && ['RegExp', 'Array', 'Object', 'Date', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Error', 'TypeError', 'RangeError'].includes(node.callee.name)) {
            return node.arguments.every(arg => !t.isSpreadElement(arg) && isPureOrRemovableExpr(arg, topLevelFns, programVars, mutatedProgramVars));
        }
        return false;
    }
    if (t.isCallExpression(node)) {
        if (!node.arguments.every(arg => !t.isSpreadElement(arg) && isPureOrRemovableExpr(arg, topLevelFns, programVars, mutatedProgramVars))) {
            return false;
        }
        const callee = node.callee;
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.object)) {
            const propName = !callee.computed && t.isIdentifier(callee.property)
                ? callee.property.name
                : (callee.computed && t.isStringLiteral(callee.property) ? callee.property.value : null);
            if (propName) {
                if (callee.object.name === 'Object' && ['create', 'keys', 'values', 'entries', 'freeze', 'getOwnPropertyDescriptor', 'getOwnPropertyNames', 'getPrototypeOf'].includes(propName)) {
                    return true;
                }
                if (callee.object.name === 'String' && ['fromCharCode', 'fromCodePoint', 'raw'].includes(propName)) {
                    return true;
                }
                if (callee.object.name === 'Array' && ['isArray', 'from', 'of'].includes(propName)) {
                    return true;
                }
                if (callee.object.name === 'Math') {
                    return true;
                }
            }
        }
        if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) {
            return isBodyFreeOfExternalSideEffects(callee, topLevelFns, programVars, mutatedProgramVars);
        }
        if (t.isIdentifier(callee) && topLevelFns && topLevelFns.has(callee.name)) {
            const fnNode = topLevelFns.get(callee.name);
            return isBodyFreeOfExternalSideEffects(fnNode, topLevelFns, programVars, mutatedProgramVars);
        }
        return false;
    }
    return false;
}

function cleanBlockScopeDeadFunctions(ast) {
    let anyRemoved = false;
    traverse(ast, {
        BlockStatement(blockPath) {
            const stmts = blockPath.node.body;
            const localFns = new Map();
            const stmtToFnName = new Map();
            stmts.forEach((stmt) => {
                if (t.isFunctionDeclaration(stmt) && stmt.id) {
                    localFns.set(stmt.id.name, stmt);
                    stmtToFnName.set(stmt, stmt.id.name);
                }
            });

            if (localFns.size === 0) return;

            const roots = new Set();
            const deps = new Map();
            for (const name of localFns.keys()) {
                deps.set(name, new Set());
            }

            for (const [name, fnStmt] of localFns.entries()) {
                const b = blockPath.scope.getBinding(name);
                if (!b) {
                    roots.add(name);
                    continue;
                }
                const allRefs = [...b.referencePaths, ...b.constantViolations];
                for (const refPath of allRefs) {
                    let ownerFn = null;
                    let curr = refPath;
                    while (curr && curr.node !== blockPath.node) {
                        if (stmtToFnName.has(curr.node)) {
                            ownerFn = stmtToFnName.get(curr.node);
                            break;
                        }
                        curr = curr.parentPath;
                    }
                    if (ownerFn) {
                        if (ownerFn !== name) {
                            deps.get(ownerFn).add(name);
                        }
                    } else {
                        if (refPath.node !== fnStmt.id) {
                            roots.add(name);
                        }
                    }
                }
            }

            const reachable = new Set(roots);
            const queue = Array.from(roots);
            while (queue.length > 0) {
                const currName = queue.shift();
                const dSet = deps.get(currName);
                if (!dSet) continue;
                for (const dep of dSet) {
                    if (!reachable.has(dep)) {
                        reachable.add(dep);
                        queue.push(dep);
                    }
                }
            }

            for (const [name] of localFns.entries()) {
                if (!reachable.has(name)) {
                    const paths = blockPath.get('body');
                    const pToRemove = paths.find(p => p.isFunctionDeclaration() && p.node.id && p.node.id.name === name);
                    if (pToRemove) {
                        pToRemove.remove();
                        anyRemoved = true;
                    }
                }
            }
        }
    });
    return anyRemoved;
}


function cleanFunctionLocalDeadBindings(ast, topLevelFns) {
    let changed = false;

    traverse(ast, {
        Scopable(path) {
            if (path.isProgram()) return;
            const scope = path.scope;
            for (const [name, binding] of Object.entries(scope.bindings)) {
                if (binding.kind !== 'var' && binding.kind !== 'let' && binding.kind !== 'const') continue;
                if (!binding.path.isVariableDeclarator() || !t.isIdentifier(binding.path.node.id)) continue;

                const init = binding.path.node.init;
                if (!isPureOrRemovableExpr(init, topLevelFns)) continue;

                if (binding.references === 0 && binding.constantViolations.length === 0) {
                    const declPath = binding.path.parentPath;
                    binding.path.remove();
                    if (declPath && declPath.isVariableDeclaration() && declPath.node.declarations.length === 0) {
                        declPath.remove();
                    }
                    changed = true;
                    continue;
                }

                let allRefsAreWriteOnly = true;
                for (const refPath of binding.referencePaths) {
                    if (
                        refPath.parentPath &&
                        refPath.parentPath.isAssignmentExpression({ operator: '=' }) &&
                        refPath.parentPath.node.left === refPath.node &&
                        refPath.parentPath.parentPath &&
                        refPath.parentPath.parentPath.isExpressionStatement() &&
                        isPureOrRemovableExpr(refPath.parentPath.node.right, topLevelFns)
                    ) {
                        continue;
                    }
                    allRefsAreWriteOnly = false;
                    break;
                }

                if (!allRefsAreWriteOnly) continue;

                const assignStmtPaths = [];
                let allViolationsRemovable = true;
                for (const violPath of binding.constantViolations) {
                    if (
                        violPath.isAssignmentExpression({ operator: '=' }) &&
                        t.isIdentifier(violPath.node.left, { name }) &&
                        violPath.parentPath &&
                        violPath.parentPath.isExpressionStatement() &&
                        isPureOrRemovableExpr(violPath.node.right, topLevelFns)
                    ) {
                        assignStmtPaths.push(violPath.parentPath);
                    } else {
                        allViolationsRemovable = false;
                        break;
                    }
                }

                if (allViolationsRemovable) {
                    for (const stmtPath of assignStmtPaths) {
                        if (!stmtPath.removed) stmtPath.remove();
                    }
                    const declPath = binding.path.parentPath;
                    if (!binding.path.removed) binding.path.remove();
                    if (declPath && !declPath.removed && declPath.isVariableDeclaration() && declPath.node.declarations.length === 0) {
                        declPath.remove();
                    }
                    changed = true;
                }
            }
        }
    });

    return changed;
}

function cleanReachabilityDCE(ast) {
    let anyChanged = false;
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 20) {
        changed = false;
        iterations++;

        if (traverse.cache && typeof traverse.cache.clear === 'function') {
            traverse.cache.clear();
        }
        let programPath;
        let programScope;
        traverse(ast, {
            Program(p) {
                programPath = p;
                programScope = p.scope;
            }
        });

        let subChanged = false;
        if (cleanBlockScopeDeadFunctions(ast)) subChanged = true;

        const topLevelFns = new Map();
        for (const stmt of ast.program.body) {
            if (t.isFunctionDeclaration(stmt) && stmt.id && t.isIdentifier(stmt.id)) {
                topLevelFns.set(stmt.id.name, stmt);
            }
        }

        if (cleanFunctionLocalDeadBindings(ast, topLevelFns)) subChanged = true;

        if (subChanged) {
            changed = true;
            programScope.crawl();
        }

        const candidateBindings = new Set();
        const nonRemovableBindings = new Set();

        for (const [name, binding] of Object.entries(programScope.bindings)) {
            if (binding.kind === 'hoisted' || binding.kind === 'var' || binding.kind === 'let' || binding.kind === 'const') {
                candidateBindings.add(name);
            } else {
                nonRemovableBindings.add(name);
            }
        }

        const deps = new Map();
        const ensureDepSet = (name) => {
            if (!deps.has(name)) deps.set(name, new Set());
            return deps.get(name);
        };

        const collectProgramRefs = (subPath, ownerName, targetSet) => {
            if (!subPath || !subPath.node) return;
            if (subPath.isIdentifier() && subPath.isReferencedIdentifier()) {
                const refName = subPath.node.name;
                if (refName !== ownerName) {
                    const b = subPath.scope.getBinding(refName);
                    if (b && b.scope === programScope) {
                        targetSet.add(refName);
                    }
                }
            }
            subPath.traverse({
                Identifier(ip) {
                    if (ip.isReferencedIdentifier()) {
                        const refName = ip.node.name;
                        if (refName !== ownerName) {
                            const b = ip.scope.getBinding(refName);
                            if (b && b.scope === programScope) {
                                targetSet.add(refName);
                            }
                        }
                    }
                }
            });
        };

        const rootRefs = new Set();
        const bodyPaths = programPath.get('body');

        for (const stmtPath of bodyPaths) {
            if (stmtPath.isFunctionDeclaration() && stmtPath.node.id && t.isIdentifier(stmtPath.node.id)) {
                const fnName = stmtPath.node.id.name;
                if (candidateBindings.has(fnName) && !nonRemovableBindings.has(fnName)) {
                    collectProgramRefs(stmtPath.get('body'), fnName, ensureDepSet(fnName));
                    continue;
                }
            }

            if (stmtPath.isVariableDeclaration()) {
                const declPaths = stmtPath.get('declarations');
                for (const dPath of declPaths) {
                    if (t.isIdentifier(dPath.node.id)) {
                        const varName = dPath.node.id.name;
                        const initNode = dPath.node.init;
                        const mutatedVars = new Set();
                        if (candidateBindings.has(varName) && !nonRemovableBindings.has(varName) && isPureOrRemovableExpr(initNode, topLevelFns, candidateBindings, mutatedVars)) {
                            if (initNode) {
                                collectProgramRefs(dPath.get('init'), varName, ensureDepSet(varName));
                                for (const mv of mutatedVars) {
                                    if (mv !== varName) ensureDepSet(mv).add(varName);
                                }
                            }
                        } else {
                            nonRemovableBindings.add(varName);
                            rootRefs.add(varName);
                            if (initNode) {
                                collectProgramRefs(dPath.get('init'), null, rootRefs);
                            }
                        }
                    } else {
                        collectProgramRefs(dPath, null, rootRefs);
                    }
                }
                continue;
            }

            if (stmtPath.isExpressionStatement()) {
                const exprPath = stmtPath.get('expression');
                const expr = exprPath.node;
                const mutatedVars = new Set();
                if (
                    t.isAssignmentExpression(expr, { operator: '=' }) &&
                    t.isIdentifier(expr.left) &&
                    candidateBindings.has(expr.left.name) &&
                    !nonRemovableBindings.has(expr.left.name) &&
                    programScope.getBinding(expr.left.name) &&
                    isPureOrRemovableExpr(expr.right, topLevelFns, candidateBindings, mutatedVars)
                ) {
                    const varName = expr.left.name;
                    collectProgramRefs(exprPath.get('right'), varName, ensureDepSet(varName));
                    for (const mv of mutatedVars) {
                        if (mv !== varName) ensureDepSet(mv).add(varName);
                    }
                    continue;
                }
            }

            collectProgramRefs(stmtPath, null, rootRefs);
        }

        traverse(ast, {
            AssignmentExpression(p) {
                if (
                    p.parentPath &&
                    p.parentPath.isExpressionStatement() &&
                    p.parentPath.parentPath &&
                    p.parentPath.parentPath.isProgram() &&
                    p.node.operator === '=' &&
                    t.isIdentifier(p.node.left) &&
                    isPureOrRemovableExpr(p.node.right, topLevelFns, candidateBindings)
                ) {
                    return;
                }
                if (t.isIdentifier(p.node.left)) {
                    const name = p.node.left.name;
                    const b = p.scope.getBinding(name);
                    if (b && b.scope === programScope) {
                        const enclosingTop = p.findParent(anc => anc.parentPath && anc.parentPath.isProgram());
                        let ownerName = null;
                        if (enclosingTop) {
                            if (enclosingTop.isFunctionDeclaration() && enclosingTop.node.id) {
                                ownerName = enclosingTop.node.id.name;
                            }
                        }
                        if (ownerName && candidateBindings.has(ownerName) && !nonRemovableBindings.has(ownerName)) {
                            if (name !== ownerName) ensureDepSet(ownerName).add(name);
                        } else {
                            rootRefs.add(name);
                        }
                    }
                }
            },
            UpdateExpression(p) {
                if (t.isIdentifier(p.node.argument)) {
                    const name = p.node.argument.name;
                    const b = p.scope.getBinding(name);
                    if (b && b.scope === programScope) {
                        const enclosingTop = p.findParent(anc => anc.parentPath && anc.parentPath.isProgram());
                        let ownerName = null;
                        if (enclosingTop && enclosingTop.isFunctionDeclaration() && enclosingTop.node.id) {
                            ownerName = enclosingTop.node.id.name;
                        }
                        if (ownerName && candidateBindings.has(ownerName) && !nonRemovableBindings.has(ownerName)) {
                            if (name !== ownerName) ensureDepSet(ownerName).add(name);
                        } else {
                            rootRefs.add(name);
                        }
                    }
                }
            }
        });

        const reachableBindings = new Set(rootRefs);
        for (const nr of nonRemovableBindings) {
            reachableBindings.add(nr);
        }
        const queue = Array.from(reachableBindings);
        while (queue.length > 0) {
            const curr = queue.shift();
            const dSet = deps.get(curr);
            if (!dSet) continue;
            for (const dep of dSet) {
                if (!reachableBindings.has(dep)) {
                    reachableBindings.add(dep);
                    queue.push(dep);
                }
            }
        }

        for (const stmtPath of programPath.get('body')) {
            if (stmtPath.isFunctionDeclaration() && stmtPath.node.id && t.isIdentifier(stmtPath.node.id)) {
                const name = stmtPath.node.id.name;
                if (!reachableBindings.has(name)) {
                    stmtPath.remove();
                    changed = true;
                    anyChanged = true;
                }
            } else if (stmtPath.isVariableDeclaration()) {
                for (const dPath of stmtPath.get('declarations')) {
                    if (t.isIdentifier(dPath.node.id)) {
                        const name = dPath.node.id.name;
                        if (!reachableBindings.has(name)) {
                            dPath.remove();
                            changed = true;
                            anyChanged = true;
                        }
                    }
                }
                if (!stmtPath.removed && stmtPath.node && stmtPath.node.declarations.length === 0) {
                    stmtPath.remove();
                    changed = true;
                    anyChanged = true;
                }
            } else if (stmtPath.isExpressionStatement()) {
                const expr = stmtPath.node.expression;
                if (
                    t.isAssignmentExpression(expr, { operator: '=' }) &&
                    t.isIdentifier(expr.left) &&
                    candidateBindings.has(expr.left.name) &&
                    !reachableBindings.has(expr.left.name)
                ) {
                    stmtPath.remove();
                    changed = true;
                    anyChanged = true;
                }
            }
        }
        if (changed) anyChanged = true;
    }
    return anyChanged;
}

function polishAST(ast) {
    let seqChanged = true;
    while (seqChanged) {
        seqChanged = false;
        traverse(ast, {
            noScope: true,
            ExpressionStatement(path) {
                if (t.isSequenceExpression(path.node.expression)) {
                    path.replaceWithMultiple(
                        path.node.expression.expressions.map(expr => t.expressionStatement(t.cloneNode(expr)))
                    );
                    seqChanged = true;
                }
            },
            ReturnStatement(path) {
                if (
                    path.parentPath &&
                    path.parentPath.isBlockStatement() &&
                    t.isSequenceExpression(path.node.argument) &&
                    path.node.argument.expressions.length > 1
                ) {
                    const exprs = path.node.argument.expressions;
                    const leading = exprs.slice(0, -1).map(expr => t.expressionStatement(t.cloneNode(expr)));
                    const last = t.cloneNode(exprs[exprs.length - 1]);
                    path.replaceWithMultiple([...leading, t.returnStatement(last)]);
                    seqChanged = true;
                }
            }
        });
    }

    if (traverse.cache && typeof traverse.cache.clear === 'function') {
        traverse.cache.clear();
    }
    traverse(ast, {
        UnaryExpression(path) {
            const { operator, argument } = path.node;
            if (operator === '!' && t.isNumericLiteral(argument)) {
                if (argument.value === 0) {
                    path.replaceWith(t.booleanLiteral(true));
                } else if (argument.value === 1) {
                    path.replaceWith(t.booleanLiteral(false));
                }
            } else if (operator === 'void' && t.isNumericLiteral(argument, { value: 0 })) {
                if (!path.scope.getBinding('undefined')) {
                    path.replaceWith(t.identifier('undefined'));
                }
            }
        },
        CallExpression(path) {
            const callee = path.node.callee;
            if (t.isSequenceExpression(callee) && callee.expressions.length === 2) {
                const [first, second] = callee.expressions;
                if (t.isNumericLiteral(first) && (first.value === 0 || first.value === 1) && t.isIdentifier(second)) {
                    path.node.callee = second;
                }
            }
        },
        NewExpression(path) {
            if (t.isIdentifier(path.node.callee, { name: 'RegExp' }) && !path.scope.getBinding('RegExp')) {
                const args = path.node.arguments;
                if (args.length >= 1 && args.length <= 2 && t.isStringLiteral(args[0]) && (args.length === 1 || t.isStringLiteral(args[1]))) {
                    const pattern = args[0].value;
                    const flags = args.length === 2 ? args[1].value : '';
                    if (pattern.length > 0 && !/[\r\n\u2028\u2029]/.test(pattern)) {
                        try {
                            new RegExp(pattern, flags);
                            const safePattern = pattern.replace(/(\\*)(\/)/g, (m, bs, sl) => (bs.length % 2 === 0 ? bs + '\\/' : m));
                            new Function(`return /${safePattern}/${flags};`);
                            path.replaceWith(t.regExpLiteral(safePattern, flags));
                        } catch (_) {}
                    }
                }
            }
        },
        MemberExpression(path) {
            if (path.node.computed && t.isStringLiteral(path.node.property)) {
                const propVal = path.node.property.value;
                if (isValidIdentifier(propVal)) {
                    path.node.computed = false;
                    path.node.property = t.identifier(propVal);
                }
            }
        },
        ObjectProperty(path) {
            if (path.node.computed && t.isStringLiteral(path.node.key)) {
                const keyVal = path.node.key.value;
                if (isValidIdentifier(keyVal)) {
                    path.node.computed = false;
                    path.node.key = t.identifier(keyVal);
                } else {
                    path.node.computed = false;
                }
            }
        },
        "ClassMethod|ObjectMethod"(path) {
            if (path.node.computed && t.isStringLiteral(path.node.key)) {
                const keyVal = path.node.key.value;
                if (isValidIdentifier(keyVal)) {
                    path.node.computed = false;
                    path.node.key = t.identifier(keyVal);
                } else {
                    path.node.computed = false;
                }
            }
        },
        NumericLiteral(path) {
            if (path.node.extra && typeof path.node.extra.raw === 'string') {
                if (/^0[xXoObB]/.test(path.node.extra.raw)) {
                    delete path.node.extra;
                }
            }
        },
        StringLiteral(path) {
            if (path.node.extra) {
                delete path.node.extra;
            }
        },
        EmptyStatement(path) {
            path.remove();
        },
        IfStatement(path) {
            if (path.node.alternate && t.isBlockStatement(path.node.alternate) && path.node.alternate.body.length === 0) {
                path.node.alternate = null;
            }
        },
        Function(path) {
            const body = path.node.body;
            if (t.isBlockStatement(body) && body.body.length > 0) {
                const paramNames = new Set();
                for (const param of path.node.params) {
                    if (t.isIdentifier(param)) {
                        paramNames.add(param.name);
                    } else if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) {
                        paramNames.add(param.left.name);
                    } else if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
                        paramNames.add(param.argument.name);
                    }
                }
                if (paramNames.size > 0) {
                    body.body = body.body.filter(stmt => {
                        if (t.isVariableDeclaration(stmt)) {
                            stmt.declarations = stmt.declarations.filter(
                                d => !(!d.init && t.isIdentifier(d.id) && paramNames.has(d.id.name))
                            );
                            if (stmt.declarations.length === 0) return false;
                        }
                        return true;
                    });
                }

                if (body.body.length > 0) {
                    const lastStmt = body.body[body.body.length - 1];
                    if (t.isReturnStatement(lastStmt)) {
                        const arg = lastStmt.argument;
                        if (
                            arg === null ||
                            (t.isIdentifier(arg, { name: 'undefined' }) && !path.scope.getBinding('undefined')) ||
                            (t.isUnaryExpression(arg, { operator: 'void' }) && t.isNumericLiteral(arg.argument, { value: 0 }))
                        ) {
                            body.body.pop();
                        }
                    }
                }
            }
        }
    });
}

module.exports = {
    cleanReachabilityDCE,
    polishAST
};
