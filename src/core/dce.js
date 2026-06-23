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
module.exports = {
    cleanBoilerplateDCE,
    removeUnusedDeclarations
};