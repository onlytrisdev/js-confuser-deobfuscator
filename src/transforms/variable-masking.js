const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { evaluateCustom } = require('../utils/ast-utils');

const ARRAY_OBJ_METHODS = new Set([
    'push', 'pop', 'shift', 'unshift', 'splice', 'slice', 'join', 'map', 'reduce',
    'forEach', 'filter', 'concat', 'indexOf', 'includes', 'keys', 'values', 'entries',
    'hasOwnProperty', 'toString', 'valueOf'
]);

function getStaticMaskKey(mNode) {
    const prop = mNode.property;
    if (t.isNumericLiteral(prop)) {
        return prop.value < 0 ? `neg_${Math.abs(prop.value)}` : prop.value.toString();
    }
    if (t.isStringLiteral(prop)) {
        return prop.value;
    }
    if (t.isUnaryExpression(prop) && prop.operator === '-' && t.isNumericLiteral(prop.argument)) {
        return `neg_${prop.argument.value}`;
    }
    if (!mNode.computed && t.isIdentifier(prop)) {
        return prop.name;
    }
    return null;
}

function isStaticMaskArray(fnPath, stackName) {
    const binding = fnPath.scope.getBinding(stackName);
    if (!binding || binding.constantViolations.length > 0) return false;

    for (const refPath of binding.referencePaths) {
        const parent = refPath.parentPath;
        if (!parent || !parent.isMemberExpression() || parent.node.object !== refPath.node) {
            return false;
        }
        const key = getStaticMaskKey(parent.node);
        if (key === null || ARRAY_OBJ_METHODS.has(key)) {
            return false;
        }
    }

    return true;
}

function unmaskVariables(ast) {
    let changed = false;

    traverse(ast, {
        Function: {
            exit(fnPath) {
                const params = fnPath.node.params;
                if (params.length !== 1 || !t.isRestElement(params[0])) return;
                if (!t.isIdentifier(params[0].argument)) return;

                const stackName = params[0].argument.name;
                if (!fnPath.get('body').isBlockStatement()) return;
                fnPath.scope.crawl();
                if (!isStaticMaskArray(fnPath, stackName)) return;

                const binding = fnPath.scope.getBinding(stackName);
                if (!binding) return;

                const bodyStmts = fnPath.get('body').get('body');
                let origParamCount = 0;
                const lengthStmtsToRemove = [];

                for (const stmtPath of bodyStmts) {
                    const stmtNode = stmtPath.node;
                    if (t.isExpressionStatement(stmtNode) && t.isAssignmentExpression(stmtNode.expression)) {
                        const left = stmtNode.expression.left;
                        if (t.isMemberExpression(left) && t.isIdentifier(left.object, { name: stackName })) {
                            const prop = left.property;
                            let isLen = false;
                            if (!left.computed && t.isIdentifier(prop, { name: 'length' })) {
                                isLen = true;
                            } else if (left.computed) {
                                if (t.isStringLiteral(prop, { value: 'length' })) {
                                    isLen = true;
                                } else {
                                    const propEval = evaluateCustom(stmtPath.get('expression.left.property'));
                                    if (propEval.confident && propEval.value === 'length') {
                                        isLen = true;
                                    }
                                }
                            }

                            if (isLen) {
                                lengthStmtsToRemove.push(stmtPath);
                                const right = stmtNode.expression.right;
                                if (t.isNumericLiteral(right)) {
                                    origParamCount = right.value;
                                } else {
                                    const evalRes = evaluateCustom(stmtPath.get('expression.right'));
                                    if (evalRes.confident && typeof evalRes.value === 'number') {
                                        origParamCount = evalRes.value;
                                    }
                                }
                            }
                        }
                    }
                }

                const keyToVarName = new Map();
                const numericIndices = new Set();
                const localVars = new Set();

                for (const refPath of binding.referencePaths) {
                    const mPath = refPath.parentPath;
                    if (!mPath || !mPath.isMemberExpression() || mPath.node.object !== refPath.node) continue;
                    const key = getStaticMaskKey(mPath.node);
                    if (key === null || key === 'length') continue;

                    const prop = mPath.node.property;
                    if (t.isNumericLiteral(prop)) {
                        numericIndices.add(prop.value);
                    }

                    if (!keyToVarName.has(key)) {
                        const numKey = Number(key);
                        if (!isNaN(numKey) && Number.isInteger(numKey) && numKey >= 0 && numKey < origParamCount) {
                            keyToVarName.set(key, fnPath.scope.generateUidIdentifier(`p${numKey}`).name);
                        } else {
                            const cleanKey = key.replace(/[^a-zA-Z0-9_$]/g, '_');
                            const varName = fnPath.scope.generateUidIdentifier(`v_${cleanKey}`).name;
                            keyToVarName.set(key, varName);
                            localVars.add(varName);
                        }
                    }
                }

                if (keyToVarName.size === 0 && lengthStmtsToRemove.length === 0) return;

                if (origParamCount === 0 && numericIndices.size > 0) {
                    let maxParam = -1;
                    while (numericIndices.has(maxParam + 1)) {
                        maxParam++;
                    }
                    if (maxParam >= 0) {
                        origParamCount = maxParam + 1;
                        for (let i = 0; i < origParamCount; i++) {
                            const key = i.toString();
                            const oldName = keyToVarName.get(key);
                            if (oldName) {
                                localVars.delete(oldName);
                            }
                            keyToVarName.set(key, fnPath.scope.generateUidIdentifier(`p${i}`).name);
                        }
                    }
                }

                for (const refPath of [...binding.referencePaths]) {
                    const mPath = refPath.parentPath;
                    if (!mPath || mPath.removed || !mPath.isMemberExpression() || mPath.node.object !== refPath.node) continue;
                    const key = getStaticMaskKey(mPath.node);
                    if (key !== null && keyToVarName.has(key)) {
                        const newName = keyToVarName.get(key);
                        mPath.replaceWith(t.identifier(newName));
                        changed = true;
                    }
                }

                for (const lenStmt of lengthStmtsToRemove) {
                    try {
                        lenStmt.remove();
                        changed = true;
                    } catch (e) {}
                }

                const newParams = [];
                for (let i = 0; i < origParamCount; i++) {
                    const pName = keyToVarName.get(i.toString()) || fnPath.scope.generateUidIdentifier(`p${i}`).name;
                    newParams.push(t.identifier(pName));
                }
                fnPath.node.params = newParams;

                if (localVars.size > 0) {
                    const decls = Array.from(localVars).map(v => t.variableDeclarator(t.identifier(v)));
                    fnPath.node.body.body.unshift(t.variableDeclaration('var', decls));
                    changed = true;
                }
            }
        }
    });

    traverse(ast, {
        Function: {
            exit(fnPath) {
                if (!fnPath.get('body').isBlockStatement()) return;
                fnPath.scope.crawl();

                const paramNames = new Set();
                for (const p of fnPath.node.params) {
                    if (t.isIdentifier(p)) paramNames.add(p.name);
                }

                const bodyPaths = fnPath.get('body.body');
                for (const stmtPath of bodyPaths) {
                    if (!stmtPath.isVariableDeclaration()) continue;
                    for (const declPath of stmtPath.get('declarations')) {
                        const decl = declPath.node;
                        if (!t.isIdentifier(decl.id) || !decl.init) continue;
                        const isEmptyArr = t.isArrayExpression(decl.init) && decl.init.elements.length === 0;
                        const isEmptyObj = t.isObjectExpression(decl.init) && decl.init.properties.length === 0;
                        if (!isEmptyArr && !isEmptyObj) continue;

                        const stackName = decl.id.name;
                        const binding = fnPath.scope.getBinding(stackName);
                        if (!binding || binding.constantViolations.length > 0 || binding.referencePaths.length === 0) continue;

                        let valid = true;
                        for (const refPath of binding.referencePaths) {
                            const parent = refPath.parentPath;
                            if (!parent || !parent.isMemberExpression() || parent.node.object !== refPath.node) {
                                valid = false;
                                break;
                            }
                            const key = getStaticMaskKey(parent.node);
                            if (key === null || ARRAY_OBJ_METHODS.has(key)) {
                                valid = false;
                                break;
                            }
                        }
                        if (!valid) continue;

                        const keyToVarName = new Map();
                        const localVars = new Set();
                        const stmtsToRemove = [];

                        for (const sPath of fnPath.get('body.body')) {
                            if (!sPath.isExpressionStatement()) continue;
                            const expr = sPath.node.expression;
                            if (!t.isAssignmentExpression(expr, { operator: '=' })) continue;
                            if (!t.isMemberExpression(expr.left) || !t.isIdentifier(expr.left.object, { name: stackName })) continue;
                            const key = getStaticMaskKey(expr.left);
                            if (key === 'length') {
                                stmtsToRemove.push(sPath);
                                continue;
                            }
                            if (key !== null && t.isIdentifier(expr.right) && paramNames.has(expr.right.name) && !keyToVarName.has(key)) {
                                const pB = fnPath.scope.getBinding(expr.right.name);
                                if (pB && pB.constantViolations.length === 0 && pB.referencePaths.length === 1) {
                                    let shadowedInRefs = false;
                                    for (const refPath of binding.referencePaths) {
                                        if (refPath.scope.getBinding(expr.right.name) !== pB) {
                                            shadowedInRefs = true;
                                            break;
                                        }
                                    }
                                    if (!shadowedInRefs) {
                                        keyToVarName.set(key, expr.right.name);
                                        stmtsToRemove.push(sPath);
                                    }
                                }
                            }
                        }

                        for (const refPath of binding.referencePaths) {
                            const parent = refPath.parentPath;
                            if (!parent || !parent.isMemberExpression()) continue;
                            const key = getStaticMaskKey(parent.node);
                            if (key === null || key === 'length') continue;
                            if (!keyToVarName.has(key)) {
                                const cleanKey = key.replace(/[^a-zA-Z0-9_$]/g, '_');
                                const vName = fnPath.scope.generateUidIdentifier(`v_${cleanKey}`).name;
                                keyToVarName.set(key, vName);
                                localVars.add(vName);
                            }
                        }

                        for (const sPath of stmtsToRemove) {
                            if (!sPath.removed) sPath.remove();
                        }

                        for (const refPath of [...binding.referencePaths]) {
                            if (refPath.removed || !refPath.parentPath || refPath.parentPath.removed) continue;
                            const parent = refPath.parentPath;
                            if (parent.isMemberExpression() && parent.node.object === refPath.node) {
                                const key = getStaticMaskKey(parent.node);
                                if (key !== null && keyToVarName.has(key)) {
                                    parent.replaceWith(t.identifier(keyToVarName.get(key)));
                                }
                            }
                        }

                        const parentVarDecl = declPath.parentPath;
                        if (!declPath.removed) declPath.remove();
                        if (parentVarDecl && !parentVarDecl.removed && parentVarDecl.isVariableDeclaration() && parentVarDecl.node.declarations.length === 0) {
                            parentVarDecl.remove();
                        }

                        if (localVars.size > 0) {
                            const decls = Array.from(localVars).map(v => t.variableDeclarator(t.identifier(v)));
                            fnPath.node.body.body.unshift(t.variableDeclaration('var', decls));
                        }

                        changed = true;
                    }
                }
            }
        }
    });

    return changed;
}

module.exports = {
    unmaskVariables
};
