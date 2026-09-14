const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { evaluateCustom, safeGlobals } = require('../utils/ast-utils');

function extractGlobalConcealingMap(funcNode) {
    if (!funcNode || funcNode.params.length !== 1) return null;
    const param = funcNode.params[0];
    let paramName = null;
    let isRest = false;

    if (t.isIdentifier(param)) {
        paramName = param.name;
    } else if (t.isRestElement(param) && t.isIdentifier(param.argument)) {
        paramName = param.argument.name;
        isRest = true;
    } else {
        return null;
    }

    const bodyStmts = funcNode.body.body;
    let switchStmt = null;
    for (const stmt of bodyStmts) {
        if (t.isSwitchStatement(stmt)) {
            const disc = stmt.discriminant;
            if (!isRest && t.isIdentifier(disc) && disc.name === paramName) {
                switchStmt = stmt;
                break;
            } else if (isRest && t.isMemberExpression(disc) && t.isIdentifier(disc.object, { name: paramName })) {
                if (t.isNumericLiteral(disc.property, { value: 0 })) {
                    switchStmt = stmt;
                    break;
                }
            }
        }
    }
    if (!switchStmt) return null;

    const globalMap = new Map(); // mappingKey -> originalGlobalName
    let globalVarName = null;

    for (const sc of switchStmt.cases) {
        if (!sc.test || !t.isStringLiteral(sc.test)) continue;
        const key = sc.test.value;
        for (const stmt of sc.consequent) {
            if (t.isReturnStatement(stmt)) {
                const retExpr = t.isSequenceExpression(stmt.argument)
                    ? stmt.argument.expressions[stmt.argument.expressions.length - 1]
                    : stmt.argument;
                if (!retExpr) continue;
                if (t.isMemberExpression(retExpr)) {
                    const mem = retExpr;
                    if (t.isIdentifier(mem.object)) {
                        globalVarName = mem.object.name;
                        let prop = null;
                        if (mem.computed && t.isStringLiteral(mem.property)) {
                            prop = mem.property.value;
                        } else if (!mem.computed && t.isIdentifier(mem.property)) {
                            prop = mem.property.name;
                        }
                        if (prop) {
                            globalMap.set(key, prop);
                        }
                    }
                } else if (t.isIdentifier(retExpr)) {
                    globalMap.set(key, retExpr.name);
                }
            }
        }
    }

    if (globalMap.size === 0) return null;
    return {
        globalMap,
        globalVarName
    };
}

function inlineGlobalConcealing(ast) {
    let changed = false;
    const globalFunctions = new Map(); // fnName -> { globalMap, globalVarName, path }
    const globalVars = new Set();
    const globalVarFnNames = new Set();

    traverse(ast, {
        FunctionDeclaration(path) {
            if (path.node.id) {
                const extracted = extractGlobalConcealingMap(path.node);
                if (extracted) {
                    globalFunctions.set(path.node.id.name, {
                        ...extracted,
                        path: path
                    });
                    if (extracted.globalVarName) {
                        globalVars.add(extracted.globalVarName);
                    }
                }
            }
        }
    });

    // Also find getGlobalVarFn
    traverse(ast, {
        VariableDeclarator(path) {
            if (t.isIdentifier(path.node.id) && globalVars.has(path.node.id.name) && path.node.init) {
                if (t.isCallExpression(path.node.init) && t.isIdentifier(path.node.init.callee)) {
                    globalVarFnNames.add(path.node.init.callee.name);
                }
            }
        }
    });

    if (globalFunctions.size === 0 && globalVars.size === 0) return false;

    // Replace calls: getGlobal(mappingKey)
    traverse(ast, {
        CallExpression(path) {
            if (t.isIdentifier(path.node.callee) && globalFunctions.has(path.node.callee.name)) {
                const fnInfo = globalFunctions.get(path.node.callee.name);
                const args = path.node.arguments;
                if (args.length === 1) {
                    let key = null;
                    if (t.isStringLiteral(args[0])) {
                        key = args[0].value;
                    } else {
                        const evalRes = evaluateCustom(path.get('arguments.0'));
                        if (evalRes.confident && typeof evalRes.value === 'string') {
                            key = evalRes.value;
                        }
                    }

                    if (key && fnInfo.globalMap.has(key)) {
                        const globalProp = fnInfo.globalMap.get(key);
                        if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(globalProp)) {
                            path.replaceWith(t.identifier(globalProp));
                            changed = true;
                        } else {
                            path.replaceWith(t.memberExpression(t.identifier('globalThis'), t.stringLiteral(globalProp), true));
                            changed = true;
                        }
                    }
                }
            }
        },
        MemberExpression(path) {
            // Replace direct access: globalVar["prop"] -> prop (if global)
            if (t.isIdentifier(path.node.object) && globalVars.has(path.node.object.name)) {
                let prop = null;
                if (path.node.computed && t.isStringLiteral(path.node.property)) {
                    prop = path.node.property.value;
                } else if (!path.node.computed && t.isIdentifier(path.node.property)) {
                    prop = path.node.property.name;
                }

                if (prop && /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(prop)) {
                    if (safeGlobals.has(prop)) {
                        path.replaceWith(t.identifier(prop));
                        changed = true;
                    }
                }
            }
        }
    });

    // Remove getGlobal functions, globalVar, and getGlobalVarFn declarations if unused
    traverse(ast, {
        FunctionDeclaration(path) {
            if (path.node.id) {
                const name = path.node.id.name;
                if (globalFunctions.has(name) || globalVarFnNames.has(name)) {
                    const binding = path.scope.getBinding(name);
                    if (!binding || binding.referencePaths.length === 0) {
                        path.remove();
                        changed = true;
                    }
                }
            }
        },
        VariableDeclarator(path) {
            if (t.isIdentifier(path.node.id) && globalVars.has(path.node.id.name)) {
                const binding = path.scope.getBinding(path.node.id.name);
                if (!binding || binding.referencePaths.length === 0) {
                    const parent = path.parentPath;
                    path.remove();
                    if (parent && parent.node && parent.node.declarations && parent.node.declarations.length === 0) {
                        parent.remove();
                    }
                    changed = true;
                }
            }
        }
    });

    return changed;
}

module.exports = {
    inlineGlobalConcealing
};
