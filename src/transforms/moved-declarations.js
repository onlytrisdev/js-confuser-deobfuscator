const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

function simplifyMovedDeclarations(ast) {
    let changed = false;

    traverse(ast, {
        IfStatement(path) {
            if (path.node.alternate) return;
            const test = path.node.test;
            if (t.isUnaryExpression(test, { operator: '!' }) && t.isIdentifier(test.argument)) {
                const fnName = test.argument.name;
                let assignExpr = null;

                const cons = path.node.consequent;
                if (t.isBlockStatement(cons) && cons.body.length === 1 && t.isExpressionStatement(cons.body[0])) {
                    assignExpr = cons.body[0].expression;
                } else if (t.isExpressionStatement(cons)) {
                    assignExpr = cons.expression;
                }

                if (assignExpr && t.isAssignmentExpression(assignExpr, { operator: '=' }) &&
                    t.isIdentifier(assignExpr.left, { name: fnName }) &&
                    t.isFunctionExpression(assignExpr.right)) {

                    const parentFn = path.getFunctionParent();
                    if (parentFn) {
                        let otherWriteInFn = false;
                        parentFn.traverse({
                            Function(fp) {
                                if (fp !== parentFn) fp.skip();
                            },
                            AssignmentExpression(ap) {
                                if (ap.node === assignExpr) return;
                                const ids = t.getBindingIdentifiers(ap.node.left);
                                if (ids[fnName]) {
                                    otherWriteInFn = true;
                                    ap.stop();
                                }
                            },
                            VariableDeclarator(vp) {
                                if (vp.node.init !== null) {
                                    const ids = t.getBindingIdentifiers(vp.node.id);
                                    if (ids[fnName]) {
                                        otherWriteInFn = true;
                                        vp.stop();
                                    }
                                }
                            }
                        });
                        if (otherWriteInFn) return;

                        const params = parentFn.node.params;
                        const idx = params.findIndex(p => t.isIdentifier(p, { name: fnName }));
                        if (idx !== -1) {
                            let callerPassesArg = false;
                            let fnBindingName = null;
                            let objBindingName = null;
                            if (parentFn.isFunctionDeclaration() && parentFn.node.id) {
                                fnBindingName = parentFn.node.id.name;
                            } else if (parentFn.isFunctionExpression()) {
                                if (parentFn.parentPath.isVariableDeclarator() && t.isIdentifier(parentFn.parentPath.node.id)) {
                                    fnBindingName = parentFn.parentPath.node.id.name;
                                } else if (parentFn.parentPath.isAssignmentExpression() && t.isIdentifier(parentFn.parentPath.node.left)) {
                                    fnBindingName = parentFn.parentPath.node.left.name;
                                } else if (parentFn.parentPath.isObjectProperty() && parentFn.parentPath.parentPath.isObjectExpression()) {
                                    const objExprPath = parentFn.parentPath.parentPath;
                                    if (objExprPath.parentPath.isVariableDeclarator() && t.isIdentifier(objExprPath.parentPath.node.id)) {
                                        objBindingName = objExprPath.parentPath.node.id.name;
                                    } else if (objExprPath.parentPath.isAssignmentExpression() && t.isIdentifier(objExprPath.parentPath.node.left)) {
                                        objBindingName = objExprPath.parentPath.node.left.name;
                                    }
                                }
                            }

                            if (fnBindingName && parentFn.scope.parent) {
                                const parentBinding = parentFn.scope.parent.getBinding(fnBindingName);
                                if (parentBinding) {
                                    let directCallCount = 0;
                                    for (const ref of parentBinding.referencePaths) {
                                        if (ref.parentPath.isCallExpression() && ref.parentPath.node.callee === ref.node) {
                                            directCallCount++;
                                            if (ref.parentPath.node.arguments.length > idx ||
                                                ref.parentPath.node.arguments.some(a => t.isSpreadElement(a))) {
                                                callerPassesArg = true;
                                                break;
                                            }
                                        }
                                    }
                                    if (directCallCount === 0) {
                                        callerPassesArg = true;
                                    }
                                } else {
                                    callerPassesArg = true;
                                }
                            } else if (objBindingName && parentFn.scope.parent) {
                                const objBinding = parentFn.scope.parent.getBinding(objBindingName);
                                if (objBinding) {
                                    let memberCallCount = 0;
                                    for (const ref of objBinding.referencePaths) {
                                        if (ref.parentPath.isMemberExpression() && ref.parentPath.node.object === ref.node) {
                                            const memParent = ref.parentPath.parentPath;
                                            if (memParent.isCallExpression() && memParent.node.callee === ref.parentPath.node) {
                                                memberCallCount++;
                                                if (memParent.node.arguments.length > idx ||
                                                    memParent.node.arguments.some(a => t.isSpreadElement(a))) {
                                                    callerPassesArg = true;
                                                    break;
                                                }
                                            } else if (memParent.isMemberExpression() &&
                                                t.isIdentifier(memParent.node.property, { name: 'apply' }) &&
                                                memParent.parentPath.isCallExpression()) {
                                                memberCallCount++;
                                                if (memParent.parentPath.node.arguments.length > 1) {
                                                    callerPassesArg = true;
                                                    break;
                                                }
                                            }
                                        }
                                    }
                                    if (memberCallCount === 0) {
                                        callerPassesArg = true;
                                    }
                                } else {
                                    callerPassesArg = true;
                                }
                            } else {
                                callerPassesArg = true;
                            }

                            if (callerPassesArg) {
                                return;
                            }
                            params.splice(idx, 1);
                        }
                    }

                    const fnExpr = assignExpr.right;
                    if (fnExpr.id && t.isIdentifier(fnExpr.id) && fnExpr.id.name !== fnName) {
                        const consPath = path.get('consequent');
                        let fnExprPath = null;
                        consPath.traverse({
                            FunctionExpression(fp) {
                                if (fp.node === fnExpr) {
                                    fnExprPath = fp;
                                    fp.stop();
                                }
                            }
                        });
                        if (fnExprPath && fnExprPath.scope) {
                            fnExprPath.scope.rename(fnExpr.id.name, fnName);
                        }
                    }
                    const fnDecl = t.functionDeclaration(
                        t.identifier(fnName),
                        fnExpr.params,
                        t.isBlockStatement(fnExpr.body) ? fnExpr.body : t.blockStatement([t.returnStatement(fnExpr.body)]),
                        fnExpr.generator,
                        fnExpr.async
                    );

                    path.replaceWith(fnDecl);
                    changed = true;
                }
            }
        }
    });

    return changed;
}

module.exports = {
    simplifyMovedDeclarations
};
