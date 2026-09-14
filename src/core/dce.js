const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const {
    numericToAST
} = require('../utils/ast-utils');

function cleanBoilerplateDCE(ast, visited, reversedGraph) {
    console.log(`[+] Cleaning boilerplate using Mark-and-Sweep DCE...`);
    let dceChanged = true;
    let dcePasses = 0;
    let dceSweptCount = 0;
    while (dceChanged && dcePasses < 10) {
        dceChanged = false;
        dcePasses++;
        const reachable = new Set();
        traverse(ast, {
            Identifier(pathNode) {
                if (pathNode.isReferencedIdentifier()) {
                    const name = pathNode.node.name;
                    let insideVisitedDecl = false;
                    let curr = pathNode.parentPath;
                    while (curr) {
                        if (curr.isFunctionDeclaration() && curr.node.id && visited.has(curr.node.id.name)) {
                            insideVisitedDecl = true;
                            break;
                        }
                        if (curr.isVariableDeclarator() && t.isIdentifier(curr.node.id) && visited.has(curr.node.id.name)) {
                            insideVisitedDecl = true;
                            break;
                        }
                        curr = curr.parentPath;
                    }
                    if (!insideVisitedDecl) {
                        reachable.add(name);
                    }
                }
            }
        });
        const queue = Array.from(reachable);
        const visitedDCE = new Set();
        while (queue.length > 0) {
            const current = queue.shift();
            if (visitedDCE.has(current)) continue;
            visitedDCE.add(current);
            if (visited.has(current)) {
                const deps = reversedGraph.get(current);
                if (deps) {
                    for (const dep of deps) {
                        if (!visitedDCE.has(dep)) {
                            queue.push(dep);
                            reachable.add(dep);
                        }
                    }
                }
            }
        }
        traverse(ast, {
            VariableDeclarator(pathNode) {
                if (t.isIdentifier(pathNode.node.id)) {
                    const name = pathNode.node.id.name;
                    if (visited.has(name) && !reachable.has(name)) {
                        pathNode.remove();
                        dceSweptCount++;
                        dceChanged = true;
                    }
                }
            },
            FunctionDeclaration(pathNode) {
                if (pathNode.node.id) {
                    const name = pathNode.node.id.name;
                    if (visited.has(name) && !reachable.has(name)) {
                        pathNode.remove();
                        dceSweptCount++;
                        dceChanged = true;
                    }
                }
            },
            ExpressionStatement(pathNode) {
                const expr = pathNode.node.expression;
                if (t.isAssignmentExpression(expr) && t.isIdentifier(expr.left)) {
                    const name = expr.left.name;
                    if (visited.has(name) && !reachable.has(name)) {
                        pathNode.remove();
                        dceSweptCount++;
                        dceChanged = true;
                        return;
                    }
                }
                if (t.isCallExpression(expr) && t.isIdentifier(expr.callee)) {
                    const name = expr.callee.name;
                    if (visited.has(name) && !reachable.has(name)) {
                        pathNode.remove();
                        dceSweptCount++;
                        dceChanged = true;
                        return;
                    }
                }
            }
        });
    }
    console.log(`[+] Boilerplate cleaning completed. Swept ${dceSweptCount} unreachable boilerplate declarations.`);
    console.log(`[+] Running final constant folding pass...`);
    let finalFoldingCount = 0;
    let finalChanged = true;
    let finalPasses = 0;
    while (finalChanged && finalPasses < 5) {
        finalChanged = false;
        finalPasses++;
        traverse(ast, {
            BinaryExpression(pathNode) {
                const {
                    left,
                    right,
                    operator
                } = pathNode.node;
                if (t.isNumericLiteral(left) && t.isNumericLiteral(right)) {
                    let val;
                    if (operator === '+') val = left.value + right.value;
                    else if (operator === '-') val = left.value - right.value;
                    else if (operator === '*') val = left.value * right.value;
                    else if (operator === '/') val = left.value / right.value;
                    else if (operator === '%') val = left.value % right.value;
                    else return;
                    if (!isFinite(val) || isNaN(val)) return;
                    pathNode.replaceWith(numericToAST(val));
                    finalFoldingCount++;
                    finalChanged = true;
                } else if (operator === '+' && t.isStringLiteral(left) && t.isStringLiteral(right)) {
                    const concatenatedString = left.value + right.value;
                    pathNode.replaceWith(t.stringLiteral(concatenatedString));
                    finalFoldingCount++;
                    finalChanged = true;
                }
            },
            MemberExpression(pathNode) {
                if (pathNode.node.computed && t.isStringLiteral(pathNode.node.property)) {
                    const propName = pathNode.node.property.value;
                    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(propName)) {
                        pathNode.node.computed = false;
                        pathNode.node.property = t.identifier(propName);
                        finalChanged = true;
                    }
                }
            }
        });
    }
}

function removeUnusedDeclarations(ast) {
    console.log(`[+] Removing unused functions and variables...`);
    let removedCount = 0;
    let unusedChanged = true;
    while (unusedChanged) {
        unusedChanged = false;
        const refCounts = new Map();
        traverse(ast, {
            Identifier(pathNode) {
                if (pathNode.isReferencedIdentifier()) {
                    const name = pathNode.node.name;
                    refCounts.set(name, (refCounts.get(name) || 0) + 1);
                }
            }
        });
        traverse(ast, {
            FunctionDeclaration(pathNode) {
                if (pathNode.node.id) {
                    const name = pathNode.node.id.name;
                    if ((refCounts.get(name) || 0) === 0) {
                        pathNode.remove();
                        removedCount++;
                        unusedChanged = true;
                    }
                }
            },
            VariableDeclarator(pathNode) {
                if (t.isIdentifier(pathNode.node.id)) {
                    const name = pathNode.node.id.name;
                    if ((refCounts.get(name) || 0) === 0) {
                        const parent = pathNode.parentPath;
                        if (!parent || !parent.node) return;
                        if (parent.parentPath && parent.parentPath.isFor()) {
                            return;
                        }
                        const init = pathNode.node.init;
                        if (init) {
                            let hasCall = false;
                            traverse(init, {
                                noScope: true,
                                CallExpression() {
                                    hasCall = true;
                                },
                                NewExpression() {
                                    hasCall = true;
                                },
                                YieldExpression() {
                                    hasCall = true;
                                },
                                AwaitExpression() {
                                    hasCall = true;
                                }
                            });
                            if (hasCall) {
                                parent.insertBefore(t.expressionStatement(t.cloneNode(init)));
                            }
                        }
                        pathNode.remove();
                        if (parent.node && parent.node.declarations && parent.node.declarations.length === 0) {
                            parent.remove();
                        }
                        removedCount++;
                        unusedChanged = true;
                    }
                }
            },
            ExpressionStatement(pathNode) {
                const expr = pathNode.node.expression;
                if (t.isAssignmentExpression(expr) && t.isIdentifier(expr.left)) {
                    const name = expr.left.name;
                    if ((refCounts.get(name) || 0) === 0) {
                        let hasCall = false;
                        traverse(expr.right, {
                            noScope: true,
                            CallExpression() {
                                hasCall = true;
                            },
                            NewExpression() {
                                hasCall = true;
                            },
                            YieldExpression() {
                                hasCall = true;
                            },
                            AwaitExpression() {
                                hasCall = true;
                            }
                        });
                        if (hasCall) {
                            pathNode.replaceWith(t.expressionStatement(t.cloneNode(expr.right)));
                        } else {
                            pathNode.remove();
                        }
                        removedCount++;
                        unusedChanged = true;
                    }
                }
            }
        });
    }
    console.log(`[+] Removed ${removedCount} unused top-level declarations.`);
}

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

function cleanBlockScopeDeadFunctions(ast) {
    let changed = true;
    while (changed) {
        changed = false;
        traverse(ast, {
            BlockStatement(blockPath) {
                const stmts = blockPath.node.body;
                const localFns = new Map();
                stmts.forEach((stmt) => {
                    if (t.isFunctionDeclaration(stmt) && stmt.id) {
                        localFns.set(stmt.id.name, stmt);
                    }
                });

                if (localFns.size === 0) return;

                // 1. Initial roots: references in non-FunctionDeclaration statements inside block
                const roots = new Set();
                stmts.forEach(stmt => {
                    if (!t.isFunctionDeclaration(stmt)) {
                        traverse(stmt, {
                            noScope: true,
                            Identifier(ip) {
                                if (localFns.has(ip.node.name)) {
                                    roots.add(ip.node.name);
                                }
                            }
                        });
                    }
                });

                // 2. Check if any function is referenced outside of blockPath (hoisting)
                const parentFn = blockPath.getFunctionParent();
                if (parentFn) {
                    parentFn.traverse({
                        Identifier(ip) {
                            if (localFns.has(ip.node.name)) {
                                let isInsideBlock = false;
                                let curr = ip.parentPath;
                                while (curr) {
                                    if (curr.node === blockPath.node) {
                                        isInsideBlock = true;
                                        break;
                                    }
                                    curr = curr.parentPath;
                                }
                                if (!isInsideBlock) {
                                    roots.add(ip.node.name);
                                }
                            }
                        }
                    });
                }

                // 3. Mark & sweep from roots among local functions
                const reachable = new Set(roots);
                const queue = Array.from(roots);
                while (queue.length > 0) {
                    const currName = queue.shift();
                    const fnStmt = localFns.get(currName);
                    if (!fnStmt) continue;
                    traverse(fnStmt, {
                        noScope: true,
                        Identifier(ip) {
                            const name = ip.node.name;
                            if (localFns.has(name) && !reachable.has(name)) {
                                reachable.add(name);
                                queue.push(name);
                            }
                        }
                    });
                }

                // 4. Remove unreachable local function declarations
                for (const [name] of localFns.entries()) {
                    if (!reachable.has(name)) {
                        const paths = blockPath.get('body');
                        const pToRemove = paths.find(p => p.isFunctionDeclaration() && p.node.id && p.node.id.name === name);
                        if (pToRemove) {
                            pToRemove.remove();
                            changed = true;
                        }
                    }
                }
            }
        });
    }
}

function cleanUnusedDecoders(ast) {
    let changed = false;
    traverse(ast, {
        IfStatement(path) {
            if (t.isUnaryExpression(path.node.test) && path.node.test.operator === '!' && t.isIdentifier(path.node.test.argument)) {
                const varName = path.node.test.argument.name;
                const fnParent = path.getFunctionParent();
                if (fnParent) {
                    let isUsed = false;
                    fnParent.traverse({
                        CallExpression(cp) {
                            if (t.isIdentifier(cp.node.callee, { name: varName })) {
                                isUsed = true;
                                cp.stop();
                            }
                        }
                    });
                    if (!isUsed) {
                        path.remove();
                        changed = true;
                    }
                }
            }
        }
    });
    return changed;
}

function cleanReachabilityDCE(ast) {
    let changed = true;
    let iterations = 0;
    while (changed && iterations < 20) {
        changed = false;
        iterations++;

        // Clean block-scoped dead functions & unused inner decoders
        cleanBlockScopeDeadFunctions(ast);
        if (cleanUnusedDecoders(ast)) changed = true;
        cleanBlockScopeDeadFunctions(ast);

        let programScope;
        traverse(ast, {
            Program(p) {
                p.scope.crawl();
                programScope = p.scope;
            }
        });

        const refCounts = new Map();
        traverse(ast, {
            Identifier(pathNode) {
                if (pathNode.isReferencedIdentifier()) {
                    const name = pathNode.node.name;
                    const binding = pathNode.scope.getBinding(name);
                    if (binding && binding.scope === programScope) {
                        refCounts.set(name, (refCounts.get(name) || 0) + 1);
                    }
                }
            }
        });

        traverse(ast, {
            FunctionDeclaration(pathNode) {
                if (pathNode.parentPath.isProgram() && pathNode.node.id) {
                    const name = pathNode.node.id.name;
                    if ((refCounts.get(name) || 0) === 0) {
                        pathNode.remove();
                        changed = true;
                    }
                }
            },
            VariableDeclarator(pathNode) {
                if (pathNode.parentPath.parentPath && pathNode.parentPath.parentPath.isProgram() && t.isIdentifier(pathNode.node.id)) {
                    const name = pathNode.node.id.name;
                    if ((refCounts.get(name) || 0) === 0) {
                        pathNode.remove();
                        changed = true;
                    }
                }
            },
            ExpressionStatement(pathNode) {
                if (pathNode.parentPath.isProgram()) {
                    const expr = pathNode.node.expression;
                    if (t.isAssignmentExpression(expr) && t.isIdentifier(expr.left)) {
                        const name = expr.left.name;
                        if ((refCounts.get(name) || 0) === 0) {
                            pathNode.remove();
                            changed = true;
                        }
                    }
                }
            }
        });

        traverse(ast, {
            VariableDeclaration(pathNode) {
                if (pathNode.parentPath.isProgram() && pathNode.node.declarations.length === 0) {
                    pathNode.remove();
                    changed = true;
                }
            }
        });
    }
}

function polishAST(ast) {
    traverse(ast, {
        ExpressionStatement(path) {
            if (t.isSequenceExpression(path.node.expression)) {
                path.replaceWithMultiple(
                    path.node.expression.expressions.map(expr => t.expressionStatement(t.cloneNode(expr)))
                );
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
        NumericLiteral(path) {
            if (path.node.extra && typeof path.node.extra.raw === 'string') {
                if (/^0[xXoObB]/.test(path.node.extra.raw)) {
                    delete path.node.extra;
                }
            }
        },
        EmptyStatement(path) {
            path.remove();
        },
        IfStatement(path) {
            if (path.node.alternate && t.isBlockStatement(path.node.alternate) && path.node.alternate.body.length === 0) {
                path.node.alternate = null;
            }
        }
    });
}

module.exports = {
    cleanBoilerplateDCE,
    removeUnusedDeclarations,
    cleanReachabilityDCE,
    polishAST
};
