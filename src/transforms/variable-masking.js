const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { evaluateCustom } = require('../utils/ast-utils');

function unmaskVariables(ast) {
    let changed = false;

    traverse(ast, {
        Function(fnPath) {
            const params = fnPath.node.params;
            if (params.length !== 1 || !t.isRestElement(params[0])) return;
            if (!t.isIdentifier(params[0].argument)) return;

            const stackName = params[0].argument.name;
            if (!fnPath.get('body').isBlockStatement()) return;

            // SAFETY CHECK: If stackName has whole-value references or dynamic indexing, it is a real array/state machine
            let hasWholeRef = false;
            let hasDynamicIndex = false;

            fnPath.traverse({
                Identifier(idPath) {
                    if (idPath.getFunctionParent() !== fnPath) return;
                    if (idPath.node.name !== stackName) return;
                    if (idPath === fnPath.get('params.0.argument')) return;

                    const parent = idPath.parentPath;
                    if (parent.isMemberExpression() && parent.node.object === idPath.node) {
                        const prop = parent.node.property;
                        const isConstant = t.isNumericLiteral(prop) || 
                                           t.isStringLiteral(prop) || 
                                           (!parent.node.computed && t.isIdentifier(prop)) ||
                                           (t.isUnaryExpression(prop) && prop.operator === '-' && t.isNumericLiteral(prop.argument));
                        if (!isConstant) {
                            hasDynamicIndex = true;
                        }
                    } else {
                        hasWholeRef = true;
                    }
                }
            });

            if (hasWholeRef || hasDynamicIndex) return;

            const bodyStmts = fnPath.get('body').get('body');
            let origParamCount = 0;
            const lengthStmtsToRemove = [];

            // Check body statements for stackName.length = N; or stackName["length"] = N;
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

            // Collect all references to stack[key]
            const keyToVarName = new Map();
            const numericIndices = new Set();
            const localVars = new Set();

            fnPath.traverse({
                MemberExpression(mPath) {
                    if (mPath.getFunctionParent() !== fnPath) return;
                    if (!t.isIdentifier(mPath.node.object, { name: stackName })) return;

                    const prop = mPath.node.property;
                    let key = null;

                    if (t.isNumericLiteral(prop)) {
                        key = prop.value.toString();
                        numericIndices.add(prop.value);
                    } else if (t.isStringLiteral(prop)) {
                        if (prop.value === 'length') return;
                        key = prop.value;
                    } else if (t.isUnaryExpression(prop) && prop.operator === '-' && t.isNumericLiteral(prop.argument)) {
                        key = 'neg_' + prop.argument.value;
                    } else if (!mPath.node.computed && t.isIdentifier(prop)) {
                        if (prop.name === 'length') return;
                        key = prop.name;
                    }

                    if (key !== null) {
                        if (!keyToVarName.has(key)) {
                            // Determine if parameter or local variable
                            const numKey = Number(key);
                            if (!isNaN(numKey) && Number.isInteger(numKey) && numKey >= 0 && numKey < origParamCount) {
                                keyToVarName.set(key, `_p${numKey}`);
                            } else {
                                const cleanKey = key.replace(/[^a-zA-Z0-9_$]/g, '_');
                                const varName = `_v_${cleanKey}`;
                                keyToVarName.set(key, varName);
                                localVars.add(varName);
                            }
                        }
                    }
                }
            });

            if (keyToVarName.size === 0 && lengthStmtsToRemove.length === 0) return;

            // If origParamCount was 0, but numeric indices like 0, 1 exist:
            if (origParamCount === 0 && numericIndices.size > 0) {
                // If 0 is referenced, consider consecutive 0..k as parameters
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
                        keyToVarName.set(key, `_p${i}`);
                    }
                }
            }

            // Replace member expressions with identifiers
            fnPath.traverse({
                MemberExpression(mPath) {
                    if (mPath.getFunctionParent() !== fnPath) return;
                    if (!t.isIdentifier(mPath.node.object, { name: stackName })) return;

                    const prop = mPath.node.property;
                    let key = null;

                    if (t.isNumericLiteral(prop)) {
                        key = prop.value.toString();
                    } else if (t.isStringLiteral(prop)) {
                        if (prop.value === 'length') return;
                        key = prop.value;
                    } else if (t.isUnaryExpression(prop) && prop.operator === '-' && t.isNumericLiteral(prop.argument)) {
                        key = 'neg_' + prop.argument.value;
                    } else if (!mPath.node.computed && t.isIdentifier(prop)) {
                        if (prop.name === 'length') return;
                        key = prop.name;
                    }

                    if (key !== null && keyToVarName.has(key)) {
                        const newName = keyToVarName.get(key);
                        mPath.replaceWith(t.identifier(newName));
                        changed = true;
                    }
                }
            });

            // Remove stack.length = N statements
            for (const lenStmt of lengthStmtsToRemove) {
                try {
                    lenStmt.remove();
                    changed = true;
                } catch (e) {}
            }

            // Restore parameters: _p0, _p1, ...
            const newParams = [];
            for (let i = 0; i < origParamCount; i++) {
                newParams.push(t.identifier(`_p${i}`));
            }
            fnPath.node.params = newParams;

            // Declare local variables at top of function body
            if (localVars.size > 0) {
                const decls = Array.from(localVars).map(v => t.variableDeclarator(t.identifier(v)));
                fnPath.node.body.body.unshift(t.variableDeclaration('var', decls));
                changed = true;
            }
        }
    });

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

    traverse(ast, {
        Function(fnPath) {
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
                        if (refPath.getFunctionParent() !== fnPath) {
                            valid = false;
                            break;
                        }
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
                                keyToVarName.set(key, expr.right.name);
                                stmtsToRemove.push(sPath);
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
                            const vName = `_v_${cleanKey}`;
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
    });

    return changed;
}

module.exports = {
    unmaskVariables
};
