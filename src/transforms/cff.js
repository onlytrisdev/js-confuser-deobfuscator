const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generator = require('@babel/generator').default;
const { cleanReachabilityDCE } = require('../core/dce');

const VALID_ID_RE = /^[$A-Z_][0-9A-Z_$]*$/i;
const RESERVED_WORDS = new Set([
    'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default',
    'delete', 'do', 'else', 'export', 'extends', 'finally', 'for', 'function',
    'if', 'import', 'in', 'instanceof', 'new', 'return', 'super', 'switch',
    'this', 'throw', 'try', 'typeof', 'var', 'void', 'while', 'with', 'yield',
    'let', 'static', 'enum', 'await', 'implements', 'package', 'protected',
    'interface', 'private', 'public', 'null', 'true', 'false'
]);

function isValidVarName(name) {
    return typeof name === 'string' && VALID_ID_RE.test(name) && !RESERVED_WORDS.has(name);
}

function getPropKeyName(node, computed) {
    if (!computed && t.isIdentifier(node)) return node.name;
    if (t.isStringLiteral(node)) return node.value;
    return null;
}

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
            if (isTargetOfAssignmentOrPattern(p)) return;

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

            if (t.isMemberExpression(p.node) && isStatesObject(p.node.object, statesVar)) {
                const val = evaluateExpr(p.node, states, statesVar);
                if (typeof val === 'number') {
                    p.replaceWith(t.valueToNode(val));
                    p.skip();
                    return;
                }
            }

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

function unboxCFFScopes(ast) {
    let changed = false;
    traverse(ast, {
        Program(p) {
            p.scope.crawl();
        }
    });

    const candidateBindings = new Map();
    traverse(ast, {
        VariableDeclarator(p) {
            if (!t.isIdentifier(p.node.id) || !t.isObjectExpression(p.node.init)) return;
            const props = p.node.init.properties;
            if (props.length === 0) return;
            const b = p.scope.getBinding(p.node.id.name);
            if (!b || b.path !== p || b.constantViolations.length > 0) return;

            const ownBuckets = new Set();
            const parentProps = [];
            let ok = true;
            for (const prop of props) {
                if (!t.isObjectProperty(prop)) { ok = false; break; }
                const k = getPropKeyName(prop.key, prop.computed);
                if (!k) { ok = false; break; }
                if (t.isObjectExpression(prop.value) && prop.value.properties.length === 0) {
                    ownBuckets.add(k);
                } else if (t.isMemberExpression(prop.value) && t.isIdentifier(prop.value.object)) {
                    const pk = getPropKeyName(prop.value.property, prop.value.computed);
                    if (pk === k) {
                        parentProps.push({ k, parentObjName: prop.value.object.name });
                    } else {
                        ok = false; break;
                    }
                } else {
                    ok = false; break;
                }
            }
            if (!ok) return;
            candidateBindings.set(b, { declPath: p, ownBuckets, parentProps, buckets: new Map() });
        }
    });

    for (const [b, info] of candidateBindings.entries()) {
        for (const ref of b.referencePaths) {
            const gp = ref.parentPath;
            if (!gp || !gp.isMemberExpression() || gp.node.object !== ref.node) continue;
            const k = getPropKeyName(gp.node.property, gp.node.computed);
            if (!k) continue;
            const ggp = gp.parentPath;
            if (ggp && ggp.isAssignmentExpression({ operator: '=' }) && ggp.node.left === gp.node &&
                t.isObjectExpression(ggp.node.right) && ggp.node.right.properties.length === 0 &&
                ggp.parentPath && ggp.parentPath.isExpressionStatement()) {
                info.ownBuckets.add(k);
            }
        }
    }

    let fixChanged = true;
    while (fixChanged) {
        fixChanged = false;
        for (const [b, info] of Array.from(candidateBindings.entries())) {
            let valid = true;
            for (const pp of info.parentProps) {
                const pb = info.declPath.scope.getBinding(pp.parentObjName);
                const pInfo = pb ? candidateBindings.get(pb) : null;
                if (!pInfo || (!pInfo.ownBuckets.has(pp.k) && !pInfo.parentProps.some(x => x.k === pp.k))) {
                    valid = false;
                    break;
                }
            }
            if (!valid) {
                candidateBindings.delete(b);
                fixChanged = true;
                continue;
            }
            for (const ref of b.referencePaths) {
                const gp = ref.parentPath;
                if (!gp || !gp.isMemberExpression() || gp.node.object !== ref.node) {
                    valid = false;
                    break;
                }
                const k = getPropKeyName(gp.node.property, gp.node.computed);
                if (!k || (!info.ownBuckets.has(k) && !info.parentProps.some(pp => pp.k === k))) {
                    valid = false;
                    break;
                }

                const ggp = gp.parentPath;
                if (ggp.isObjectProperty() && ggp.node.value === gp.node &&
                    ggp.parentPath.isObjectExpression() && ggp.parentPath.parentPath.isVariableDeclarator()) {
                    const childDecl = ggp.parentPath.parentPath;
                    if (t.isIdentifier(childDecl.node.id)) {
                        const childB = childDecl.scope.getBinding(childDecl.node.id.name);
                        if (childB && candidateBindings.has(childB)) continue;
                    }
                    valid = false;
                    break;
                }
                if (ggp.isAssignmentExpression({ operator: '=' }) && ggp.node.left === gp.node &&
                    t.isObjectExpression(ggp.node.right) && ggp.node.right.properties.length === 0 &&
                    ggp.parentPath.isExpressionStatement()) {
                    continue;
                }
                if (ggp.isMemberExpression() && ggp.node.object === gp.node) {
                    const varName = getPropKeyName(ggp.node.property, ggp.node.computed);
                    if (isValidVarName(varName)) continue;
                }
                valid = false;
                break;
            }
            if (!valid) {
                candidateBindings.delete(b);
                fixChanged = true;
            }
        }
    }

    if (candidateBindings.size > 0) {
        const bucketVarMap = new Map();
        const bucketVarList = new Map();
        let resolveChanged = true;
        while (resolveChanged) {
            resolveChanged = false;
            for (const [, info] of candidateBindings.entries()) {
                for (const k of info.ownBuckets) {
                    if (!info.buckets.has(k)) {
                        const bucket = { rootDeclPath: info.declPath, key: k };
                        info.buckets.set(k, bucket);
                        bucketVarMap.set(bucket, new Map());
                        bucketVarList.set(bucket, new Set());
                        resolveChanged = true;
                    }
                }
                for (const pp of info.parentProps) {
                    if (!info.buckets.has(pp.k)) {
                        const pb = info.declPath.scope.getBinding(pp.parentObjName);
                        const pInfo = candidateBindings.get(pb);
                        if (pInfo && pInfo.buckets.has(pp.k)) {
                            info.buckets.set(pp.k, pInfo.buckets.get(pp.k));
                            resolveChanged = true;
                        }
                    }
                }
            }
        }

        const replacements = [];
        const stmtsToRemove = new Set();
        for (const [b, info] of candidateBindings.entries()) {
            for (const ref of b.referencePaths) {
                const gp = ref.parentPath;
                const k = getPropKeyName(gp.node.property, gp.node.computed);
                const bucket = info.buckets.get(k);
                const ggp = gp.parentPath;
                if (ggp.isObjectProperty()) continue;
                if (ggp.isAssignmentExpression() && ggp.node.left === gp.node) {
                    stmtsToRemove.add(ggp.parentPath);
                    continue;
                }
                const varName = getPropKeyName(ggp.node.property, ggp.node.computed);
                const vMap = bucketVarMap.get(bucket);
                let finalName = vMap.get(varName);
                if (!finalName) {
                    finalName = varName;
                    vMap.set(varName, finalName);
                    bucketVarList.get(bucket).add(finalName);
                }
                replacements.push({ targetPath: ggp, newIdName: finalName });
            }
        }

        for (const { targetPath, newIdName } of replacements) {
            if (!targetPath.removed) {
                targetPath.replaceWith(t.identifier(newIdName));
                changed = true;
            }
        }
        for (const s of stmtsToRemove) {
            if (!s.removed) {
                s.remove();
                changed = true;
            }
        }
        for (const [bucket, vars] of bucketVarList.entries()) {
            if (vars.size === 0) continue;
            const blockPath = bucket.rootDeclPath.findParent(p => p.isBlockStatement() || p.isProgram());
            if (!blockPath) continue;
            const existing = new Set();
            if (blockPath.parentPath && blockPath.parentPath.isFunction()) {
                for (const param of blockPath.parentPath.node.params) {
                    if (t.isIdentifier(param)) existing.add(param.name);
                    else if (t.isAssignmentPattern(param) && t.isIdentifier(param.left)) existing.add(param.left.name);
                    else if (t.isRestElement(param) && t.isIdentifier(param.argument)) existing.add(param.argument.name);
                }
            }
            for (const stmt of blockPath.node.body) {
                if (t.isVariableDeclaration(stmt)) {
                    for (const d of stmt.declarations) {
                        if (t.isIdentifier(d.id)) existing.add(d.id.name);
                    }
                } else if (t.isFunctionDeclaration(stmt) && stmt.id) {
                    existing.add(stmt.id.name);
                }
            }
            const toDeclare = Array.from(vars).filter(v => !existing.has(v));
            if (toDeclare.length > 0) {
                blockPath.node.body.unshift(
                    t.variableDeclaration('var', toDeclare.map(v => t.variableDeclarator(t.identifier(v))))
                );
                changed = true;
            }
        }
        for (const [, info] of candidateBindings.entries()) {
            const parent = info.declPath.parentPath;
            if (!info.declPath.removed) info.declPath.remove();
            if (parent && !parent.removed && parent.isVariableDeclaration() && parent.node.declarations.length === 0) {
                parent.remove();
            }
            changed = true;
        }
    }

    traverse(ast, {
        CallExpression(p) {
            if (t.isSequenceExpression(p.node.callee) && p.node.callee.expressions.length === 2 &&
                t.isNumericLiteral(p.node.callee.expressions[0]) && t.isIdentifier(p.node.callee.expressions[1])) {
                p.node.callee = p.node.callee.expressions[1];
                changed = true;
            }
        }
    });

    return changed;
}

function restoreCFFParamsAndFunctions(ast) {
    let changed = false;
    traverse(ast, {
        Program(p) {
            p.scope.crawl();
        }
    });

    traverse(ast, {
        Function(p) {
            const params = p.node.params;
            if (params.length !== 1 || !t.isRestElement(params[0]) || !t.isIdentifier(params[0].argument)) return;
            const restName = params[0].argument.name;
            const body = p.node.body.body;
            if (!Array.isArray(body)) return;

            let aliasName = restName;
            let aliasStmtIdx = -1;
            let destructStmtIdx = -1;
            let pattern = null;

            for (let i = 0; i < Math.min(body.length, 8); i++) {
                const stmt = body[i];
                if (t.isVariableDeclaration(stmt)) {
                    if (stmt.declarations.every(d => !d.init || t.isUnaryExpression(d.init, { operator: 'void' }) || t.isIdentifier(d.init, { name: 'undefined' }))) {
                        continue;
                    }
                    if (stmt.declarations.length === 1) {
                        const d = stmt.declarations[0];
                        if (t.isIdentifier(d.id) && t.isIdentifier(d.init, { name: restName })) {
                            aliasName = d.id.name;
                            aliasStmtIdx = i;
                            continue;
                        }
                        if (t.isArrayPattern(d.id) && t.isIdentifier(d.init, { name: aliasName })) {
                            pattern = d.id;
                            destructStmtIdx = i;
                            break;
                        }
                    }
                } else if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression, { operator: '=' })) {
                    const { left, right } = stmt.expression;
                    if (t.isIdentifier(left) && t.isIdentifier(right, { name: restName })) {
                        aliasName = left.name;
                        aliasStmtIdx = i;
                        continue;
                    }
                    if ((t.isArrayPattern(left) || t.isArrayExpression(left)) && t.isIdentifier(right, { name: aliasName })) {
                        pattern = left;
                        destructStmtIdx = i;
                        break;
                    }
                }
            }

            if (pattern && destructStmtIdx !== -1 &&
                pattern.elements.every(el => !el || t.isIdentifier(el) || (t.isAssignmentPattern(el) && t.isIdentifier(el.left)) || (t.isRestElement(el) && t.isIdentifier(el.argument)))) {
                const newParams = pattern.elements.map((el, idx) => el ? t.cloneNode(el) : p.scope.generateUidIdentifier(`p${idx}`));
                const paramNames = new Set();
                for (const np of newParams) {
                    if (t.isIdentifier(np)) paramNames.add(np.name);
                    else if (t.isAssignmentPattern(np) && t.isIdentifier(np.left)) paramNames.add(np.left.name);
                    else if (t.isRestElement(np) && t.isIdentifier(np.argument)) paramNames.add(np.argument.name);
                }
                p.node.params = newParams;
                body.splice(destructStmtIdx, 1);
                if (aliasStmtIdx !== -1) {
                    body.splice(aliasStmtIdx > destructStmtIdx ? aliasStmtIdx - 1 : aliasStmtIdx, 1);
                    paramNames.add(aliasName);
                }
                for (let i = body.length - 1; i >= 0; i--) {
                    if (t.isVariableDeclaration(body[i])) {
                        body[i].declarations = body[i].declarations.filter(d => !(t.isIdentifier(d.id) && !d.init && paramNames.has(d.id.name)));
                        if (body[i].declarations.length === 0) body.splice(i, 1);
                    }
                }
                changed = true;
            } else {
                const restBinding = p.scope.getBinding(restName);
                if (restBinding && restBinding.referencePaths.length === 0) {
                    p.node.params = [];
                    changed = true;
                } else if (restBinding && restBinding.referencePaths.length === 1) {
                    const ref = restBinding.referencePaths[0];
                    if (ref.parentPath.isVariableDeclarator() && t.isIdentifier(ref.parentPath.node.id)) {
                        const aliasB = p.scope.getBinding(ref.parentPath.node.id.name);
                        if (aliasB && aliasB.referencePaths.length === 0 && aliasB.constantViolations.length === 0) {
                            const declParent = ref.parentPath.parentPath;
                            if (!ref.parentPath.removed) ref.parentPath.remove();
                            if (declParent && !declParent.removed && declParent.node && declParent.node.declarations.length === 0) {
                                declParent.remove();
                            }
                            p.node.params = [];
                            changed = true;
                        }
                    }
                }
            }
        }
    });

    traverse(ast, {
        Program(p) {
            p.scope.crawl();
        }
    });

    traverse(ast, {
        ExpressionStatement(p) {
            if (!p.parentPath.isProgram() && !(p.parentPath.isBlockStatement() && p.parentPath.parentPath && p.parentPath.parentPath.isFunction())) return;
            if (!t.isAssignmentExpression(p.node.expression, { operator: '=' })) return;
            const { left, right } = p.node.expression;
            if (!t.isIdentifier(left)) return;
            const fnName = left.name;
            const b = p.scope.getBinding(fnName);
            if (b && b.constantViolations.length === 1 && b.path.isVariableDeclarator() && !b.path.node.init) {
                if (t.isFunctionExpression(right)) {
                    if (right.id && t.isIdentifier(right.id) && right.id.name !== fnName) {
                        const rightPath = p.get('expression.right');
                        if (rightPath && rightPath.scope) {
                            rightPath.scope.rename(right.id.name, fnName);
                        }
                    }
                    const declParent = b.path.parentPath;
                    b.path.remove();
                    if (declParent && !declParent.removed && declParent.isVariableDeclaration() && declParent.node.declarations.length === 0) {
                        declParent.remove();
                    }
                    p.replaceWith(t.functionDeclaration(t.identifier(fnName), right.params, right.body, right.generator, right.async));
                    changed = true;
                } else if (t.isClassExpression(right)) {
                    const declBlock = b.path.findParent(anc => anc.isBlockStatement() || anc.isProgram());
                    if (declBlock === p.parentPath) {
                        if (right.id && t.isIdentifier(right.id) && right.id.name !== fnName) {
                            const rightPath = p.get('expression.right');
                            if (rightPath && rightPath.scope) {
                                rightPath.scope.rename(right.id.name, fnName);
                            }
                        }
                        const declParent = b.path.parentPath;
                        b.path.remove();
                        if (declParent && !declParent.removed && declParent.isVariableDeclaration() && declParent.node.declarations.length === 0) {
                            declParent.remove();
                        }
                        p.replaceWith(t.classDeclaration(t.identifier(fnName), right.superClass, right.body, right.decorators));
                        changed = true;
                    }
                } else if (
                    t.isStringLiteral(right) ||
                    t.isNumericLiteral(right) ||
                    t.isBooleanLiteral(right) ||
                    (t.isArrayExpression(right) && right.elements.every(el =>
                        el && (t.isLiteral(el) || (t.isIdentifier(el) && el.name === 'undefined') ||
                        (t.isUnaryExpression(el) && (el.operator === '-' || el.operator === '+' || el.operator === '!' || el.operator === 'void') && t.isLiteral(el.argument)))
                    ))
                ) {
                    const declBlock = b.path.findParent(anc => anc.isBlockStatement() || anc.isProgram());
                    if (declBlock === p.parentPath) {
                        b.path.node.init = right;
                        p.remove();
                        changed = true;
                    }
                }
            }
        }
    });

    traverse(ast, {
        Function(p) {
            const body = p.node.body;
            if (t.isBlockStatement(body) && body.body.length > 0) {
                const last = body.body[body.body.length - 1];
                if (t.isReturnStatement(last)) {
                    const arg = last.argument;
                    if (arg === null ||
                        (t.isIdentifier(arg, { name: 'undefined' }) && !p.scope.getBinding('undefined')) ||
                        (t.isUnaryExpression(arg, { operator: 'void' }) && t.isNumericLiteral(arg.argument, { value: 0 }))) {
                        body.body.pop();
                        changed = true;
                    }
                }
            }
        }
    });

    return changed;
}

function hasTopLevelReturn(stmts) {
    const dummyProg = t.program(stmts.map(s => t.cloneNode(s)));
    let found = false;
    traverse(dummyProg, {
        noScope: true,
        Function(p) {
            p.skip();
        },
        ReturnStatement(p) {
            found = true;
            p.stop();
        }
    });
    return found;
}

function unwrapCFF(ast) {
    let changed = false;

    traverse(ast, {
        Program(p) {
            p.scope.crawl();
        }
    });

    const sequences = new Map();
    const sliceFunctions = new Map();
    const sumFunctions = new Set();
    const xorFunctions = new Map();
    const stringsMap = new Map();

    traverse(ast, {
        VariableDeclarator(path) {
            if (t.isIdentifier(path.node.id) && t.isArrayExpression(path.node.init)) {
                const elements = path.node.init.elements;
                if (elements.length >= 20 && elements.every(el => el !== null && getNumVal(el) !== null)) {
                    sequences.set(path.node.id.name, elements.map(el => getNumVal(el)));
                }
            }
            if (t.isIdentifier(path.node.id) && t.isStringLiteral(path.node.init) && path.node.init.value.length >= 20) {
                const ex = stringsMap.get(path.node.id.name);
                if (!ex || path.node.init.value.length > ex.length) {
                    stringsMap.set(path.node.id.name, path.node.init.value);
                }
            }
        },
        AssignmentExpression(path) {
            if (path.node.operator !== '=' || !t.isIdentifier(path.node.left)) return;
            const name = path.node.left.name;
            if (t.isArrayExpression(path.node.right)) {
                const elements = path.node.right.elements;
                if (elements.length >= 20 && elements.every(el => el !== null && getNumVal(el) !== null)) {
                    sequences.set(name, elements.map(el => getNumVal(el)));
                }
            }
            if (t.isStringLiteral(path.node.right) && path.node.right.value.length >= 20) {
                const ex = stringsMap.get(name);
                if (!ex || path.node.right.value.length > ex.length) {
                    stringsMap.set(name, path.node.right.value);
                }
            }
        }
    });

    traverse(ast, {
        FunctionDeclaration(path) {
            if (!path.node.id) return;
            if (!path.node.body || !Array.isArray(path.node.body.body) || path.node.body.body.length > 25) return;
            const fnName = path.node.id.name;
            const bodyCode = generator(path.node.body).code;

            if ((bodyCode.includes('["length"]') || bodyCode.includes('.length')) &&
                (bodyCode.includes('sum +=') || (bodyCode.includes('+=') && bodyCode.includes('return')))) {
                sumFunctions.add(fnName);
            }

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

    if (sumFunctions.size > 0) {
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

        for (let level = 0; level < 8; level++) {
            let levelChanged = false;
            const rawWhileCandidates = [];
            const rawWhileNodes = new Set();

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

                    rawWhileNodes.add(path.node);
                    rawWhileCandidates.push({
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

            const cffWhileCandidates = rawWhileCandidates.filter(
                cand => !cand.whilePath.findParent(anc => rawWhileNodes.has(anc.node))
            );
            if (cffWhileCandidates.length === 0) break;

            for (const candidate of cffWhileCandidates) {
            try {
                const { enclosingFn, statesVarNode: origStatesVarNode, endState, switchNode } = candidate;
                const mainFnName = enclosingFn.node.id.name;

                let statesVarNode = origStatesVarNode;

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
                                        throw new Error('Dynamic state transition cannot be determined');
                                    }
                                } else if (t.isUpdateExpression(expr) && t.isMemberExpression(expr.argument) &&
                                           isStatesObject(expr.argument.object, statesVarNode)) {
                                    const leftIdx = evaluateExpr(expr.argument.property, st, statesVarNode, sequences);
                                    if (leftIdx !== null && st[leftIdx] !== undefined) {
                                        if (expr.operator === '++') st[leftIdx]++;
                                        else if (expr.operator === '--') st[leftIdx]--;
                                    } else {
                                        throw new Error('Dynamic state update cannot be determined');
                                    }
                                }
                            }
                        }
                    }
                }

                let totalSteps = 0;
                function traceFlow(st, depth = 0, stopAtSum = null, visited = new Set()) {
                    if (++totalSteps > 500) {
                        throw new Error('CFF trace total steps exceeded limit');
                    }
                    if (depth > 200) {
                        throw new Error('CFF trace recursion depth exceeded limit');
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
                        if (t.isReturnStatement(s) || t.isThrowStatement(s)) {
                            retStmt = s;
                            break;
                        } else if (t.isIfStatement(s)) {
                            const condVal = evaluateExpr(s.test, st, statesVarNode, sequences);
                            if (condVal === false) {
                                continue;
                            } else if (condVal === true) {
                                applyStateAssignments(st, s.consequent.body || [s.consequent]);
                                break;
                            } else if (t.isMemberExpression(s.test)) {
                                applyStateAssignments(st, s.consequent.body || [s.consequent]);
                                break;
                            } else {
                                const consStmts = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
                                const isGuardReturn = !s.alternate && consStmts.some(x => t.isReturnStatement(x) || t.isThrowStatement(x));
                                if (isGuardReturn) {
                                    const clonedGuard = t.cloneNode(s);
                                    simplifyStatesInNode(clonedGuard, st, statesVarNode, xorFunctions, stringsMap);
                                    emitted.push(clonedGuard);
                                    continue;
                                }
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

                        function getPathSums(startSt) {
                            const sums = [];
                            const curr = [...startSt];
                            for (let i = 0; i < 40; i++) {
                                const s = curr.reduce((a, b) => a + b, 0);
                                sums.push(s);
                                if (s === endState) break;
                                const b = findBlock(curr);
                                if (!b) break;
                                if (b.statements.some(x => t.isReturnStatement(x) || t.isThrowStatement(x))) break;
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

                    applyStateAssignments(st, transitions);
                    const nextStmts = traceFlow(st, depth + 1, stopAtSum, nextVisited);
                    emitted.push(...nextStmts);
                    return emitted;
                }

                const savedBody = enclosingFn.node.body;
                enclosingFn.node.body = t.blockStatement([]);

                try {
                    for (let wave = 0; wave < 15; wave++) {
                        enclosingFn.parentPath.scope.crawl();
                        const binding = enclosingFn.parentPath.scope.getBinding(mainFnName);
                        if (!binding) break;

                        const externalCalls = binding.referencePaths
                            .filter(r => r.parentPath && r.parentPath.isCallExpression() && r.parentPath.node.callee === r.node && !r.findParent(p => p === enclosingFn))
                            .map(r => r.parentPath);

                        if (externalCalls.length === 0) {
                            break;
                        }

                        const replacements = [];

                        for (const callPath of externalCalls) {
                            const arg0 = callPath.node.arguments[0];
                            const initStates = evalArrayElements(arg0);
                            if (!initStates) continue;

                            try {
                                totalSteps = 0;
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
                                continue;
                            }
                        }

                        if (replacements.length === 0) break;

                        for (const { callPath, reconstructed } of replacements) {
                            if (callPath.parentPath.isReturnStatement()) {
                                const fnParent = callPath.getFunctionParent();
                                if (fnParent && fnParent !== enclosingFn) {
                                    if (fnParent.node.body && t.isBlockStatement(fnParent.node.body) && fnParent.node.body.body.length === 1) {
                                        fnParent.node.body = t.blockStatement(reconstructed);
                                        changed = true;
                                        levelChanged = true;
                                        continue;
                                    }
                                }
                            }

                            let stmtPath = callPath.getStatementParent();
                            if (stmtPath && stmtPath.parentPath && stmtPath.parentPath.isBlock()) {
                                const blockBody = stmtPath.parentPath.node.body;
                                const idx = blockBody.indexOf(stmtPath.node);
                                if (idx !== -1) {
                                    let countToRemove = 1;
                                    let isReturnIf = false;
                                    let isDirectReturnVar = false;

                                    let assignedVarName = null;
                                    if (stmtPath.isExpressionStatement() && t.isAssignmentExpression(stmtPath.node.expression, { operator: '=' }) &&
                                        t.isIdentifier(stmtPath.node.expression.left) && stmtPath.node.expression.right === callPath.node) {
                                        assignedVarName = stmtPath.node.expression.left.name;
                                    } else if (stmtPath.isVariableDeclaration() && stmtPath.node.declarations.length === 1 &&
                                               t.isIdentifier(stmtPath.node.declarations[0].id) && stmtPath.node.declarations[0].init === callPath.node) {
                                        assignedVarName = stmtPath.node.declarations[0].id.name;
                                    }

                                    if (idx + 1 < blockBody.length) {
                                        const next = blockBody[idx + 1];
                                        if (t.isIfStatement(next) && !next.alternate && (
                                            t.isReturnStatement(next.consequent) ||
                                            (t.isBlockStatement(next.consequent) && next.consequent.body.length === 1 && t.isReturnStatement(next.consequent.body[0]))
                                        )) {
                                            isReturnIf = true;
                                            countToRemove = 2;
                                        } else if (assignedVarName && t.isReturnStatement(next) && t.isIdentifier(next.argument, { name: assignedVarName })) {
                                            isDirectReturnVar = true;
                                            countToRemove = 2;
                                        }
                                    }

                                    const isStandalone = stmtPath.isExpressionStatement() && (
                                        stmtPath.node.expression === callPath.node ||
                                        (t.isSequenceExpression(stmtPath.node.expression) &&
                                         stmtPath.node.expression.expressions[stmtPath.node.expression.expressions.length - 1] === callPath.node)
                                    );

                                    const isAssignOrVar = Boolean(assignedVarName) || (stmtPath.isExpressionStatement() && (
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

                                    const isTopLevelProgram = stmtPath.parentPath.isProgram();
                                    if (isTopLevelProgram && reconstructed.length > 0) {
                                        const progWrap = t.program(reconstructed);
                                        traverse(progWrap, {
                                            noScope: true,
                                            Function(fp) {
                                                fp.skip();
                                            },
                                            ReturnStatement(rp) {
                                                const arg = rp.node.argument;
                                                if (!arg || t.isIdentifier(arg, { name: 'undefined' }) ||
                                                    (t.isUnaryExpression(arg, { operator: 'void' }) && t.isNumericLiteral(arg.argument, { value: 0 }))) {
                                                    rp.remove();
                                                } else {
                                                    rp.replaceWith(t.expressionStatement(arg));
                                                }
                                            }
                                        });
                                        reconstructed.splice(0, reconstructed.length, ...progWrap.body);
                                    }

                                    const hasReturn = hasTopLevelReturn(reconstructed);

                                    if ((!isTopLevelProgram || !hasReturn) &&
                                        ((isReturnIf && (isStandalone || isAssignOrVar)) || isDirectReturnVar || (isStandalone && !isReturnIf))) {
                                        let startIdx = idx;
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
                                        levelChanged = true;
                                        continue;
                                    }
                                }
                            }

                            const iife = t.callExpression(
                                t.functionExpression(null, [], t.blockStatement(reconstructed)),
                                []
                            );
                            callPath.replaceWith(iife);
                            changed = true;
                            levelChanged = true;
                        }
                    }

                    enclosingFn.parentPath.scope.crawl();
                    const updatedBinding = enclosingFn.parentPath.scope.getBinding(mainFnName);
                    const remainingExternalRefs = updatedBinding
                        ? updatedBinding.referencePaths.filter(r => !r.findParent(p => p === enclosingFn))
                        : [];
                    if (remainingExternalRefs.length === 0) {
                        enclosingFn.remove();
                        changed = true;
                        levelChanged = true;
                    } else {
                        enclosingFn.node.body = savedBody;
                    }
                } catch (innerErr) {
                    if (!enclosingFn.removed) {
                        enclosingFn.node.body = savedBody;
                    }
                }
            } catch (candErr) {}
            }
            if (unboxCFFScopes(ast)) changed = true;
            if (restoreCFFParamsAndFunctions(ast)) changed = true;
            if (!levelChanged) break;
        }
    } else {
        if (unboxCFFScopes(ast)) changed = true;
        if (restoreCFFParamsAndFunctions(ast)) changed = true;
    }

    if (changed) {
        cleanReachabilityDCE(ast);
    }

    return changed;
}

module.exports = {
    unwrapCFF,
    unboxCFFScopes,
    restoreCFFParamsAndFunctions
};
