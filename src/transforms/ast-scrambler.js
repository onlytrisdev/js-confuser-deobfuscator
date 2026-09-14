const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

function isAstScramblerFunction(pathNode) {
    if (!pathNode.isFunctionDeclaration()) return false;
    const node = pathNode.node;
    if (!node.id) return false;
    const fnName = node.id.name;

    // Body must be reassigning itself: fn = function() {}
    const bodyStmts = node.body.body;
    if (bodyStmts.length === 1) {
        const stmt = bodyStmts[0];
        if (t.isExpressionStatement(stmt)) {
            const expr = stmt.expression;
            if (t.isAssignmentExpression(expr) && t.isIdentifier(expr.left) && expr.left.name === fnName) {
                if (t.isFunctionExpression(expr.right) && expr.right.body.body.length === 0) {
                    return true;
                }
            }
        }
    }
    return false;
}

function unwrapAstScrambler(ast) {
    let changed = false;
    const scramblerBindings = new Set();

    traverse(ast, {
        FunctionDeclaration(path) {
            if (isAstScramblerFunction(path)) {
                const binding = path.scope.getBinding(path.node.id.name);
                if (binding) {
                    scramblerBindings.add(binding);
                }
            }
        }
    });

    if (scramblerBindings.size === 0) return false;

    // Replace calls
    traverse(ast, {
        ExpressionStatement(path) {
            const expr = path.node.expression;
            if (t.isCallExpression(expr) && t.isIdentifier(expr.callee)) {
                const binding = path.scope.getBinding(expr.callee.name);
                if (binding && scramblerBindings.has(binding)) {
                    const args = expr.arguments;
                    if (args.length === 0) {
                        path.remove();
                        changed = true;
                    } else {
                        const stmts = args.map(arg => t.expressionStatement(t.cloneNode(arg)));
                        path.replaceWithMultiple(stmts);
                        changed = true;
                    }
                }
            }
        },
        CallExpression(path) {
            if (t.isIdentifier(path.node.callee)) {
                const binding = path.scope.getBinding(path.node.callee.name);
                if (binding && scramblerBindings.has(binding)) {
                    // If not handled by ExpressionStatement (nested in an expression)
                    if (path.parentPath.isExpressionStatement()) return;
                    const args = path.node.arguments;
                    if (args.length === 0) {
                        path.replaceWith(t.identifier('undefined'));
                        changed = true;
                    } else if (args.length === 1) {
                        path.replaceWith(t.cloneNode(args[0]));
                        changed = true;
                    } else {
                        path.replaceWith(t.sequenceExpression(args.map(a => t.cloneNode(a))));
                        changed = true;
                    }
                }
            }
        }
    });

    // Remove declarations of scrambler functions
    for (const binding of scramblerBindings) {
        if (binding.path && binding.path.isFunctionDeclaration()) {
            try {
                binding.path.remove();
                changed = true;
            } catch (e) {}
        }
    }

    return changed;
}

module.exports = {
    unwrapAstScrambler
};
