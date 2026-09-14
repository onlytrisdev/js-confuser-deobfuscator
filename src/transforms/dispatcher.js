const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generator = require('@babel/generator').default;

function unwrapDispatcher(ast) {
    let changed = false;

    // 1. Locate all dispatcher functions
    // A dispatcher function contains `var fns = { ... };` and `flagArg` logic
    const dispatchers = new Map();

    traverse(ast, {
        FunctionDeclaration(path) {
            if (!path.node.id) return;
            const dispatcherName = path.node.id.name;

            let fnsObject = null;
            let payloadVarName = null;
            let nonCallKey = null;

            path.traverse({
                VariableDeclarator(varPath) {
                    if (varPath.getFunctionParent() !== path) return;
                    if (t.isObjectExpression(varPath.node.init)) {
                        const props = varPath.node.init.properties;
                        if (props.length > 0 && props.every(p => t.isFunctionExpression(p.value) || t.isObjectMethod(p))) {
                            fnsObject = varPath.node.init;
                        }
                    }
                },
                AssignmentExpression(assignPath) {
                    if (assignPath.getFunctionParent() !== path) return;
                    if (t.isObjectExpression(assignPath.node.right)) {
                        const props = assignPath.node.right.properties;
                        if (props.length > 0 && props.every(p => t.isFunctionExpression(p.value) || t.isObjectMethod(p))) {
                            fnsObject = assignPath.node.right;
                        }
                    }
                    if (t.isIdentifier(assignPath.node.left)) {
                        if (t.isArrayExpression(assignPath.node.right) && assignPath.node.right.elements.length === 0) {
                            payloadVarName = assignPath.node.left.name;
                        } else if (t.isIdentifier(assignPath.node.right, { name: 'args' })) {
                            payloadVarName = assignPath.node.left.name;
                        }
                    }
                },
                IfStatement(ifPath) {
                    if (ifPath.getFunctionParent() !== path) return;
                    const bodyCode = generator(ifPath.node.consequent).code;
                    if (bodyCode.includes('createFunction') || bodyCode.includes('apply') || bodyCode.includes('cache')) {
                        ifPath.get('test').traverse({
                            BinaryExpression(binPath) {
                                if (binPath.node.operator === '===' || binPath.node.operator === '==') {
                                    let strVal = null;
                                    if (t.isStringLiteral(binPath.node.left)) strVal = binPath.node.left.value;
                                    else if (t.isStringLiteral(binPath.node.right)) strVal = binPath.node.right.value;
                                    if (strVal && strVal.length >= 5) {
                                        nonCallKey = strVal;
                                    }
                                }
                            }
                        });
                        if (!nonCallKey && t.isBinaryExpression(ifPath.node.test)) {
                            const test = ifPath.node.test;
                            if (t.isStringLiteral(test.left)) nonCallKey = test.left.value;
                            else if (t.isStringLiteral(test.right)) nonCallKey = test.right.value;
                        }
                    }
                }
            });

            // Safety check: if dispatcher contains local helper FunctionDeclarations that
            // dispatched functions rely on via closure, skip unwrapping to avoid breaking execution.
            let hasLocalHelperFns = false;
            path.get('body.body').forEach(s => {
                if (s.isFunctionDeclaration()) hasLocalHelperFns = true;
            });
            if (hasLocalHelperFns) return;
            if (!fnsObject) return;

            // Extract each dispatched function
            const functionMap = new Map(); // key -> { fnNode, params, name }

            for (const prop of fnsObject.properties) {
                let key = null;
                if (t.isStringLiteral(prop.key)) key = prop.key.value;
                else if (t.isIdentifier(prop.key)) key = prop.key.name;
                if (!key) continue;

                let fnExpr = prop.value;
                if (!fnExpr || !t.isFunctionExpression(fnExpr)) continue;

                let params = [];
                const bodyStmts = [...fnExpr.body.body];

                // If fnExpr had rest parameter ...maskId, prepare var maskId = [];
                // This ensures maskId is locally scoped and doesn't collide with or overwrite outer scope variables
                let maskDecl = null;
                if (fnExpr.params.length === 1 && t.isRestElement(fnExpr.params[0]) && t.isIdentifier(fnExpr.params[0].argument)) {
                    const maskId = fnExpr.params[0].argument.name;
                    maskDecl = t.variableDeclaration('var', [
                        t.variableDeclarator(t.identifier(maskId), t.arrayExpression([]))
                    ]);
                }

                // Scan bodyStmts for statement that unpacks payload
                let payloadStmtIdx = -1;
                let patternElements = null;

                for (let i = 0; i < bodyStmts.length; i++) {
                    const stmt = bodyStmts[i];
                    if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
                        const decl = stmt.declarations[0];
                        if (t.isArrayPattern(decl.id) && t.isIdentifier(decl.init)) {
                            if (!payloadVarName || decl.init.name === payloadVarName) {
                                payloadVarName = decl.init.name;
                                patternElements = decl.id.elements;
                                payloadStmtIdx = i;
                                break;
                            }
                        }
                    } else if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
                        const assign = stmt.expression;
                        if ((t.isArrayPattern(assign.left) || t.isArrayExpression(assign.left)) && t.isIdentifier(assign.right)) {
                            if (!payloadVarName || assign.right.name === payloadVarName) {
                                payloadVarName = assign.right.name;
                                patternElements = assign.left.elements;
                                payloadStmtIdx = i;
                                break;
                            }
                        }
                    }
                }

                if (payloadStmtIdx !== -1 && patternElements) {
                    bodyStmts.splice(payloadStmtIdx, 1);

                    // Check if nested array pattern: [flatObj, [p0, p1]]
                    let hasNested = false;
                    for (const el of patternElements) {
                        if (el && (t.isArrayPattern(el) || t.isArrayExpression(el))) {
                            hasNested = true;
                            break;
                        }
                    }

                    if (hasNested) {
                        const outerParams = [];
                        const prependedStmts = [];
                        for (let i = 0; i < patternElements.length; i++) {
                            const el = patternElements[i];
                            if (el && (t.isArrayPattern(el) || t.isArrayExpression(el))) {
                                const argsId = path.scope.generateUidIdentifier('args');
                                outerParams.push(argsId);
                                prependedStmts.push(
                                    t.expressionStatement(
                                        t.assignmentExpression('=', t.cloneNode(el), t.logicalExpression('||', t.cloneNode(argsId), t.arrayExpression([])))
                                    )
                                );
                            } else if (el && t.isMemberExpression(el)) {
                                const paramId = path.scope.generateUidIdentifier(`p${i}`);
                                outerParams.push(paramId);
                                prependedStmts.push(
                                    t.expressionStatement(
                                        t.assignmentExpression('=', t.cloneNode(el), t.cloneNode(paramId))
                                    )
                                );
                            } else if (el && (t.isIdentifier(el) || t.isPattern(el) || t.isRestElement(el))) {
                                outerParams.push(t.cloneNode(el));
                            } else {
                                const paramId = path.scope.generateUidIdentifier(`p${i}`);
                                outerParams.push(paramId);
                                if (el) {
                                    prependedStmts.push(
                                        t.expressionStatement(
                                            t.assignmentExpression('=', t.cloneNode(el), t.cloneNode(paramId))
                                        )
                                    );
                                }
                            }
                        }
                        params = outerParams;
                        bodyStmts.unshift(...prependedStmts);\n                    } else {
                        let stackName = null;
                        if (patternElements.length > 0 && t.isMemberExpression(patternElements[0]) && t.isIdentifier(patternElements[0].object)) {
                            stackName = patternElements[0].object.name;
                        }

                        const tempBlock = t.blockStatement(bodyStmts);

                        params = patternElements.map((el, idx) => {
                            if (el && t.isMemberExpression(el)) {
                                const paramId = path.scope.generateUidIdentifier(`p${idx}`);
                                traverse(tempBlock, {
                                    noScope: true,
                                    Function(f) { f.skip(); },
                                    MemberExpression(mPath) {
                                        if (t.isNodesEquivalent(mPath.node, el)) {
                                            mPath.replaceWith(t.cloneNode(paramId));
                                        }
                                    }
                                });
                                bodyStmts.unshift(
                                    t.expressionStatement(
                                        t.assignmentExpression('=', t.cloneNode(el), t.cloneNode(paramId))
                                    )
                                );
                                return paramId;
                            }
                            if (el && (t.isIdentifier(el) || t.isPattern(el) || t.isRestElement(el))) {
                                return t.cloneNode(el);
                            }
                            const fallbackId = path.scope.generateUidIdentifier(`p${idx}`);
                            if (el) {
                                bodyStmts.unshift(
                                    t.expressionStatement(
                                        t.assignmentExpression('=', t.cloneNode(el), t.cloneNode(fallbackId))
                                    )
                                );
                            }
                            return fallbackId;
                        });

                        if (stackName) {
                            const localVars = new Set();
                            traverse(tempBlock, {
                                noScope: true,
                                Function(f) { f.skip(); },
                                MemberExpression(mPath) {
                                    if (t.isIdentifier(mPath.node.object, { name: stackName })) {
                                        const prop = mPath.node.property;
                                        let pKey = null;
                                        if (t.isNumericLiteral(prop)) {
                                            pKey = prop.value < 0 ? `neg_${Math.abs(prop.value)}` : prop.value.toString();
                                        } else if (t.isUnaryExpression(prop) && prop.operator === '-' && t.isNumericLiteral(prop.argument)) {
                                            pKey = `neg_${prop.argument.value}`;
                                        } else if (t.isStringLiteral(prop)) {
                                            pKey = prop.value;
                                        } else if (t.isIdentifier(prop) && !mPath.node.computed) {
                                            pKey = prop.name;
                                        }
                                        if (pKey !== null) {
                                            const cleanKey = pKey.replace(/[^a-zA-Z0-9_$]/g, '_');
                                            const vName = `_v_${cleanKey}`;
                                            localVars.add(vName);
                                            mPath.replaceWith(t.identifier(vName));
                                        }
                                    }
                                }
                            });
                            if (localVars.size > 0) {
                                bodyStmts.unshift(t.variableDeclaration('var', Array.from(localVars).map(v => t.variableDeclarator(t.identifier(v)))));
                            }
                        }
                    }
                } else if (payloadVarName) {
                    const restId = path.scope.generateUidIdentifier('args');
                    params = [t.restElement(restId)];
                    bodyStmts.unshift(
                        t.expressionStatement(
                            t.assignmentExpression('=', t.identifier(payloadVarName), t.cloneNode(restId))
                        )
                    );
                }

                if (maskDecl) {
                    bodyStmts.unshift(maskDecl);
                }

                const targetScope = path.parentPath.scope || path.scope;
                const cleanKey = key.replace(/[^a-zA-Z0-9_$]/g, '_');
                const standaloneFnName = targetScope.generateUidIdentifier(`_disp_fn_${cleanKey}`).name;
                const newFnDecl = t.functionDeclaration(
                    t.identifier(standaloneFnName),
                    params,
                    t.blockStatement(bodyStmts),
                    fnExpr.generator,
                    fnExpr.async
                );

                functionMap.set(key, {
                    name: standaloneFnName,
                    fnDecl: newFnDecl
                });
            }

            dispatchers.set(dispatcherName, {
                path,
                functionMap,
                payloadVarName,
                nonCallKey
            });
        }
    });

    if (dispatchers.size === 0) return false;

    // 2. Insert extracted function declarations before the dispatcher
    for (const [dispatcherName, info] of dispatchers.entries()) {
        if (info.functionMap.size === 0) continue;
        const parentBlock = info.path.parentPath;
        if (!parentBlock.isBlock() && !parentBlock.isProgram()) continue;

        const bodyList = parentBlock.node.body || [];
        for (const [key, fnInfo] of info.functionMap.entries()) {
            const alreadyExists = bodyList.some(s => t.isFunctionDeclaration(s) && s.id && s.id.name === fnInfo.name);
            if (!alreadyExists) {
                info.path.insertBefore(fnInfo.fnDecl);
            }
        }
    }

    // 3. Transform call sites
    for (const [dispatcherName, info] of dispatchers.entries()) {
        const { functionMap, payloadVarName, nonCallKey } = info;

        // Pattern A: SequenceExpression (..., payload = [args], dispatcher(key, ...))
        traverse(ast, {
            SequenceExpression(path) {
                const exprs = path.node.expressions;
                if (exprs.length >= 2) {
                    const last = exprs[exprs.length - 1];

                    // Check if last is dispatcher call or member expression around it
                    let callNode = last;
                    let isWrappedReturn = false;
                    let memberProp = null;

                    if (t.isMemberExpression(last)) {
                        callNode = last.object;
                        memberProp = last.property;
                        isWrappedReturn = true;
                    }

                    if ((t.isCallExpression(callNode) || t.isNewExpression(callNode)) && t.isIdentifier(callNode.callee, { name: dispatcherName })) {
                        const callArgs = callNode.arguments;
                        if (callArgs.length >= 1 && t.isStringLiteral(callArgs[0])) {
                            const key = callArgs[0].value;
                            const fnInfo = functionMap.get(key);
                            if (fnInfo) {
                                // Extract args from preceding expressions: payload = [arg1, arg2]
                                let passedArgs = [];
                                for (let i = exprs.length - 2; i >= 0; i--) {
                                    const expr = exprs[i];
                                    if (t.isAssignmentExpression(expr) && t.isArrayExpression(expr.right)) {
                                        passedArgs = expr.right.elements.map(a => t.cloneNode(a));
                                        break;
                                    }
                                }

                                const newCall = t.callExpression(t.identifier(fnInfo.name), passedArgs);
                                path.replaceWith(newCall);
                                changed = true;
                            }
                        }
                    }
                }
            },
            CallExpression(path) {
                if (t.isIdentifier(path.node.callee, { name: dispatcherName })) {
                    const callArgs = path.node.arguments;
                    if (callArgs.length >= 1 && t.isStringLiteral(callArgs[0])) {
                        const key = callArgs[0].value;
                        const fnInfo = functionMap.get(key);
                        if (fnInfo) {
                            const secondArg = callArgs[1];
                            const isNonCall = secondArg && t.isStringLiteral(secondArg) && 
                                (secondArg.value === 'nonCall' || (nonCallKey && secondArg.value === nonCallKey));

                            // Check if parent is member expression: dispatcher(...)["prop"]
                            let targetPath = path;
                            if (path.parentPath.isMemberExpression() && path.parentPath.node.object === path.node) {
                                targetPath = path.parentPath;
                            }

                            // If inside a SequenceExpression, let SequenceExpression visitor handle it
                            if (targetPath.parentPath.isSequenceExpression()) {
                                return;
                            }

                            if (isNonCall) {
                                targetPath.replaceWith(t.identifier(fnInfo.name));
                            } else {
                                let passedArgs = [];
                                const stmtPath = targetPath.getStatementParent();
                                if (stmtPath && stmtPath.container && Array.isArray(stmtPath.container)) {
                                    const idx = stmtPath.key;
                                    if (typeof idx === 'number' && idx > 0) {
                                        const prevStmt = stmtPath.getSibling(idx - 1);
                                        if (prevStmt && prevStmt.isExpressionStatement() && t.isAssignmentExpression(prevStmt.node.expression)) {
                                            const assign = prevStmt.node.expression;
                                            if (t.isArrayExpression(assign.right) && (!payloadVarName || (t.isIdentifier(assign.left) && assign.left.name === payloadVarName))) {
                                                passedArgs = assign.right.elements.map(a => t.cloneNode(a));
                                                prevStmt.remove();
                                            }
                                        }
                                    }
                                }
                                targetPath.replaceWith(t.callExpression(t.identifier(fnInfo.name), passedArgs));
                            }
                            changed = true;
                        }
                    }
                }
            },
            NewExpression(path) {
                if (t.isIdentifier(path.node.callee, { name: dispatcherName })) {
                    const callArgs = path.node.arguments;
                    if (callArgs.length >= 1 && t.isStringLiteral(callArgs[0])) {
                        const key = callArgs[0].value;
                        const fnInfo = functionMap.get(key);
                        if (fnInfo) {
                            const secondArg = callArgs[1];
                            const isNonCall = secondArg && t.isStringLiteral(secondArg) && 
                                (secondArg.value === 'nonCall' || (nonCallKey && secondArg.value === nonCallKey));

                            // Check if parent is member expression: new dispatcher(...)["prop"]
                            let targetPath = path;
                            if (path.parentPath.isMemberExpression() && path.parentPath.node.object === path.node) {
                                targetPath = path.parentPath;
                            }

                            // If inside a SequenceExpression, let SequenceExpression visitor handle it
                            if (targetPath.parentPath.isSequenceExpression()) {
                                return;
                            }

                            if (isNonCall) {
                                targetPath.replaceWith(t.identifier(fnInfo.name));
                            } else {
                                let passedArgs = [];
                                const stmtPath = targetPath.getStatementParent();
                                if (stmtPath && stmtPath.container && Array.isArray(stmtPath.container)) {
                                    const idx = stmtPath.key;
                                    if (typeof idx === 'number' && idx > 0) {
                                        const prevStmt = stmtPath.getSibling(idx - 1);
                                        if (prevStmt && prevStmt.isExpressionStatement() && t.isAssignmentExpression(prevStmt.node.expression)) {
                                            const assign = prevStmt.node.expression;
                                            if (t.isArrayExpression(assign.right) && (!payloadVarName || (t.isIdentifier(assign.left) && assign.left.name === payloadVarName))) {
                                                passedArgs = assign.right.elements.map(a => t.cloneNode(a));
                                                prevStmt.remove();
                                            }
                                        }
                                    }
                                }
                                targetPath.replaceWith(t.callExpression(t.identifier(fnInfo.name), passedArgs));
                            }
                            changed = true;
                        }
                    }
                }
            }
        });

        // Remove the dispatcher function only if all call sites resolved
        if (info.functionMap.size > 0) {
            let hasRemainingRefs = false;
            traverse(ast, {
                Identifier(idPath) {
                    if (idPath.node.name === dispatcherName && idPath !== info.path.get('id') && !idPath.findParent(p => p === info.path)) {
                        hasRemainingRefs = true;
                        idPath.stop();
                    }
                }
            });

            if (!hasRemainingRefs) {
                try {
                    info.path.remove();
                    changed = true;
                } catch (e) {}
            }
        }
    }

    // Remove unreferenced payload variables and cache variables
    traverse(ast, {
        VariableDeclarator(path) {
            for (const [, info] of dispatchers) {
                if (info.payloadVarName && t.isIdentifier(path.node.id, { name: info.payloadVarName })) {
                    if (path.scope.getBinding(info.payloadVarName)?.references === 0) {
                        path.remove();
                        changed = true;
                    }
                }
            }
        }
    });

    return changed;
}

module.exports = {
    unwrapDispatcher
};
