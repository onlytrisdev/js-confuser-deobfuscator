const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

function normalizeFunctionParameters(restoredParams, fnPath, flatFnNode) {
    const prependedParamStmts = [];
    const neededVarDecls = [];
    const normalized = restoredParams.map((param, idx) => {
        if (!param) return fnPath.scope.generateUidIdentifier(`p${idx}`);
        if (t.isIdentifier(param) || t.isPattern(param) || t.isRestElement(param)) {
            return param;
        }
        const pId = fnPath.scope.generateUidIdentifier(`p${idx}`);
        if (t.isMemberExpression(param) && t.isIdentifier(param.object)) {
            const objName = param.object.name;
            const hasDecl = fnPath.scope.hasBinding(objName) || flatFnNode.body.body.some(s =>
                t.isVariableDeclaration(s) && s.declarations.some(d => t.isIdentifier(d.id, { name: objName }))
            );
            if (!hasDecl && !neededVarDecls.some(s => s.declarations.some(d => d.id.name === objName))) {
                const initExpr = t.isNumericLiteral(param.property) ? t.arrayExpression([]) : t.objectExpression([]);
                neededVarDecls.push(
                    t.variableDeclaration('var', [
                        t.variableDeclarator(t.identifier(objName), initExpr)
                    ])
                );
            }
        }
        prependedParamStmts.push(
            t.expressionStatement(t.assignmentExpression('=', t.cloneNode(param), t.cloneNode(pId)))
        );
        return pId;
    });

    if (neededVarDecls.length > 0) {
        flatFnNode.body.body.unshift(...neededVarDecls);
    }

    let insertIdx = 0;
    while (insertIdx < flatFnNode.body.body.length && t.isVariableDeclaration(flatFnNode.body.body[insertIdx])) {
        insertIdx++;
    }
    flatFnNode.body.body.splice(insertIdx, 0, ...prependedParamStmts);
    return normalized;
}

function unwrapFlatten(ast) {
    let changed = false;

    const flattenedWrappers = [];

    traverse(ast, {
        Function(fnPath) {
            if (!fnPath.node.body || !t.isBlockStatement(fnPath.node.body)) return;
            const body = fnPath.node.body.body;
            if (body.length < 2) return;

            let candidateFlatObjName = null;
            let candidateFlatFnName = null;

            for (const stmt of body) {
                if (t.isReturnStatement(stmt) && t.isCallExpression(stmt.argument)) {
                    const call = stmt.argument;
                    if (t.isIdentifier(call.callee) && call.arguments.length >= 1 && t.isIdentifier(call.arguments[0])) {
                        candidateFlatFnName = call.callee.name;
                        candidateFlatObjName = call.arguments[0].name;
                        break;
                    }
                }
            }

            if (!candidateFlatFnName || !candidateFlatObjName) return;

            let flatObjExpr = null;
            for (const stmt of body) {
                if (t.isVariableDeclaration(stmt)) {
                    for (const decl of stmt.declarations) {
                        if (t.isIdentifier(decl.id, { name: candidateFlatObjName }) && t.isObjectExpression(decl.init)) {
                            flatObjExpr = decl.init;
                            break;
                        }
                    }
                } else if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
                    const assign = stmt.expression;
                    if (t.isIdentifier(assign.left, { name: candidateFlatObjName }) && t.isObjectExpression(assign.right)) {
                        flatObjExpr = assign.right;
                        break;
                    }
                }
            }

            if (!flatObjExpr) return;

            flattenedWrappers.push({
                fnPath,
                flatObjName: candidateFlatObjName,
                flatObjExpr,
                flatFnName: candidateFlatFnName
            });
        }
    });

    if (flattenedWrappers.length === 0) return false;

    for (const wrapper of flattenedWrappers) {
        const { fnPath, flatObjName, flatObjExpr, flatFnName } = wrapper;

        let flatFnPath = null;
        let flatFnNode = null;

        traverse(ast, {
            FunctionDeclaration(p) {
                if (p.node.id && p.node.id.name === flatFnName) {
                    flatFnPath = p;
                    flatFnNode = p.node;
                    p.stop();
                }
            }
        });

        if (!flatFnNode || !flatFnPath) continue;

        const getterMap = new Map();
        const setterMap = new Map();
        const methodMap = new Map();

        for (const prop of flatObjExpr.properties) {
            let key = null;
            if (t.isStringLiteral(prop.key)) key = prop.key.value;
            else if (t.isIdentifier(prop.key)) key = prop.key.name;
            if (!key) continue;

            if (t.isObjectMethod(prop)) {
                if (prop.kind === 'get') {
                    const retStmt = prop.body.body.find(s => t.isReturnStatement(s));
                    if (retStmt) {
                        getterMap.set(key, retStmt.argument);
                    }
                } else if (prop.kind === 'set') {
                    const stmt = prop.body.body.find(s => t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression));
                    if (stmt) {
                        setterMap.set(key, stmt.expression.left);
                    }
                } else if (prop.kind === 'method') {
                    const retStmt = prop.body.body.find(s => t.isReturnStatement(s));
                    if (retStmt && t.isCallExpression(retStmt.argument)) {
                        methodMap.set(key, retStmt.argument.callee);
                    }
                }
            }
        }

        const flatParams = flatFnNode.params;
        const candidateParam = flatParams[0];
        let isFirstParamFlatObj = false;
        let flatObjParamName = null;

        const allKeys = new Set([...getterMap.keys(), ...setterMap.keys(), ...methodMap.keys()]);

        if (candidateParam && t.isIdentifier(candidateParam)) {
            const candName = candidateParam.name;
            const candNodes = [t.identifier(candName)];

            for (const stmt of flatFnNode.body.body) {
                if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
                    if (t.isIdentifier(stmt.expression.right, { name: candName })) {
                        candNodes.push(stmt.expression.left);
                    }
                }
            }

            flatFnPath.traverse({
                MemberExpression(mPath) {
                    const matches = candNodes.some(node => t.isNodesEquivalent(mPath.node.object, node));
                    if (matches) {
                        let prop = null;
                        if (t.isStringLiteral(mPath.node.property)) prop = mPath.node.property.value;
                        else if (!mPath.node.computed && t.isIdentifier(mPath.node.property)) prop = mPath.node.property.name;
                        if (prop && allKeys.has(prop)) {
                            isFirstParamFlatObj = true;
                            mPath.stop();
                        }
                    }
                }
            });
            if (isFirstParamFlatObj || (allKeys.size === 0 && t.isIdentifier(candidateParam))) {
                isFirstParamFlatObj = true;
                flatObjParamName = candName;
            }
        }

        let restoredParams = [];

        if (isFirstParamFlatObj) {
            if (flatParams.length >= 2) {
                const secondParam = flatParams[1];
                if (t.isArrayPattern(secondParam)) {
                    restoredParams = secondParam.elements.map(el => t.cloneNode(el));
                } else {
                    restoredParams = flatParams.slice(1).map(p => t.cloneNode(p));
                }
            }
            if (restoredParams.length === 1 && (t.isIdentifier(restoredParams[0]) || (t.isRestElement(restoredParams[0]) && t.isIdentifier(restoredParams[0].argument))) && flatFnNode.body) {
                const argsName = t.isIdentifier(restoredParams[0]) ? restoredParams[0].name : restoredParams[0].argument.name;
                const isMatchingRight = (expr) => {
                    if (!expr) return false;
                    if (t.isIdentifier(expr, { name: argsName })) return true;
                    if (t.isLogicalExpression(expr) && t.isIdentifier(expr.left, { name: argsName })) return true;
                    return false;
                };

                for (let i = 0; i < flatFnNode.body.body.length; i++) {
                    const stmt = flatFnNode.body.body[i];
                    if (t.isVariableDeclaration(stmt) && stmt.declarations.length === 1) {
                        const decl = stmt.declarations[0];
                        if (t.isArrayPattern(decl.id) && isMatchingRight(decl.init)) {
                            restoredParams = decl.id.elements.map(el => t.cloneNode(el));
                            flatFnNode.body.body.splice(i, 1);
                            break;
                        }
                    } else if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
                        const assign = stmt.expression;
                        if ((t.isArrayPattern(assign.left) || t.isArrayExpression(assign.left)) && isMatchingRight(assign.right)) {
                            restoredParams = assign.left.elements.map(el => t.cloneNode(el));
                            flatFnNode.body.body.splice(i, 1);
                            break;
                        }
                    }
                }
            }
        } else {
            if (flatParams.length === 1 && t.isRestElement(flatParams[0]) &&
                fnPath.node.params.length === 1 && t.isRestElement(fnPath.node.params[0])) {
                const restParamName = flatParams[0].argument.name;
                const wrapperRestId = fnPath.scope.generateUidIdentifier('args');

                for (const stmt of flatFnNode.body.body) {
                    if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
                        if (t.isIdentifier(stmt.expression.right, { name: restParamName })) {
                            stmt.expression.right = t.arrayExpression([
                                t.objectExpression(flatObjExpr.properties.map(p => t.cloneNode(p))),
                                t.cloneNode(wrapperRestId)
                            ]);
                        }
                    } else if (t.isVariableDeclaration(stmt)) {
                        for (const d of stmt.declarations) {
                            if (d.init && t.isIdentifier(d.init, { name: restParamName })) {
                                d.init = t.arrayExpression([
                                    t.objectExpression(flatObjExpr.properties.map(p => t.cloneNode(p))),
                                    t.cloneNode(wrapperRestId)
                                ]);
                            }
                        }
                    }
                }
                restoredParams = [t.restElement(wrapperRestId)];
            } else {
                restoredParams = flatParams.map(p => t.cloneNode(p));
            }
        }

        if (restoredParams.length === 0 && fnPath.node.params.length > 0 && !t.isRestElement(fnPath.node.params[0])) {
            restoredParams = fnPath.node.params.map(p => t.cloneNode(p));
        }

        const targetObjNodes = [];
        if (flatObjName) targetObjNodes.push(t.identifier(flatObjName));
        if (flatObjParamName) targetObjNodes.push(t.identifier(flatObjParamName));

        if (isFirstParamFlatObj && flatObjParamName) {
            for (const stmt of flatFnNode.body.body) {
                if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
                    if (t.isIdentifier(stmt.expression.right, { name: flatObjParamName })) {
                        targetObjNodes.push(stmt.expression.left);
                    }
                }
            }
        }

        if (targetObjNodes.length > 0) {
            flatFnPath.traverse({
                MemberExpression(mPath) {
                    const isTarget = targetObjNodes.some(target => t.isNodesEquivalent(mPath.node.object, target));
                    if (!isTarget) return;

                    let propName = null;
                    if (t.isStringLiteral(mPath.node.property)) propName = mPath.node.property.value;
                    else if (!mPath.node.computed && t.isIdentifier(mPath.node.property)) propName = mPath.node.property.name;
                    if (!propName) return;

                    if (mPath.parentPath.isAssignmentExpression() && mPath.parentPath.node.left === mPath.node) {
                        const target = setterMap.get(propName) || getterMap.get(propName);
                        if (target) {
                            mPath.replaceWith(t.cloneNode(target));
                            changed = true;
                        }
                    } else if (mPath.parentPath.isUpdateExpression() && mPath.parentPath.node.argument === mPath.node) {
                        const target = setterMap.get(propName) || getterMap.get(propName);
                        if (target) {
                            mPath.replaceWith(t.cloneNode(target));
                            changed = true;
                        }
                    } else if (mPath.parentPath.isCallExpression() && mPath.parentPath.node.callee === mPath.node) {
                        const calleeTarget = methodMap.get(propName) || getterMap.get(propName);
                        if (calleeTarget) {
                            mPath.replaceWith(t.cloneNode(calleeTarget));
                            changed = true;
                        }
                    } else {
                        const expr = getterMap.get(propName);
                        if (expr) {
                            mPath.replaceWith(t.cloneNode(expr));
                            changed = true;
                        }
                    }
                }
            });
        }

        if (isFirstParamFlatObj && flatObjParamName) {
            flatFnNode.body.body = flatFnNode.body.body.filter(stmt => {
                if (t.isExpressionStatement(stmt) && t.isAssignmentExpression(stmt.expression)) {
                    if (t.isIdentifier(stmt.expression.right, { name: flatObjParamName })) {
                        return false;
                    }
                }
                if (t.isVariableDeclaration(stmt)) {
                    stmt.declarations = stmt.declarations.filter(d => !(d.init && t.isIdentifier(d.init, { name: flatObjParamName })));
                    if (stmt.declarations.length === 0) return false;
                }
                return true;
            });
        }

        restoredParams = normalizeFunctionParameters(restoredParams, fnPath, flatFnNode);

        fnPath.node.body = t.cloneNode(flatFnNode.body);
        fnPath.node.params = restoredParams;

        try {
            flatFnPath.remove();
        } catch (e) {}

        changed = true;
    }

    return changed;
}

module.exports = {
    unwrapFlatten
};
