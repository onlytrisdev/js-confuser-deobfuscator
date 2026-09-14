const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

function simplifyOpaquePredicates(ast) {
    let changed = false;

    // 1. Find all dummy functions (empty body)
    const dummyFunctions = new Set();
    traverse(ast, {
        FunctionDeclaration(path) {
            if (path.node.id && path.node.body.body.length === 0) {
                dummyFunctions.add(path.node.id.name);
            }
        }
    });

    // 2. Replace `"prop" in dummyFn` with false, and `!("prop" in dummyFn)` with true
    traverse(ast, {
        BinaryExpression(path) {
            if (path.node.operator === 'in') {
                const right = path.node.right;
                if (t.isIdentifier(right) && dummyFunctions.has(right.name)) {
                    path.replaceWith(t.booleanLiteral(false));
                    changed = true;
                }
            }
        }
    });

    // 3. Simplify booleans, logical expressions, conditionals, and if-statements in a loop
    let simplified = true;
    while (simplified) {
        simplified = false;

        traverse(ast, {
            // !false -> true, !true -> false
            UnaryExpression(path) {
                if (path.node.operator === '!') {
                    if (t.isBooleanLiteral(path.node.argument)) {
                        path.replaceWith(t.booleanLiteral(!path.node.argument.value));
                        simplified = true;
                        changed = true;
                    }
                }
            },
            // Logical expressions: &&, ||
            LogicalExpression(path) {
                const { left, right, operator } = path.node;
                if (t.isBooleanLiteral(left)) {
                    if (operator === '&&') {
                        if (left.value) {
                            path.replaceWith(t.cloneNode(right));
                        } else {
                            path.replaceWith(t.booleanLiteral(false));
                        }
                        simplified = true;
                        changed = true;
                    } else if (operator === '||') {
                        if (left.value) {
                            path.replaceWith(t.booleanLiteral(true));
                        } else {
                            path.replaceWith(t.cloneNode(right));
                        }
                        simplified = true;
                        changed = true;
                    }
                } else if (t.isBooleanLiteral(right)) {
                    if (operator === '&&') {
                        if (right.value) {
                            path.replaceWith(t.cloneNode(left));
                            simplified = true;
                            changed = true;
                        }
                    } else if (operator === '||') {
                        if (!right.value) {
                            path.replaceWith(t.cloneNode(left));
                            simplified = true;
                            changed = true;
                        }
                    }
                }
            },
            // Conditional expressions: true ? a : b -> a
            ConditionalExpression(path) {
                if (t.isBooleanLiteral(path.node.test)) {
                    if (path.node.test.value) {
                        path.replaceWith(t.cloneNode(path.node.consequent));
                    } else {
                        path.replaceWith(t.cloneNode(path.node.alternate));
                    }
                    simplified = true;
                    changed = true;
                }
            },
            // IfStatement: if (true) { ... } else { ... }
            IfStatement(path) {
                if (t.isBooleanLiteral(path.node.test)) {
                    if (path.node.test.value) {
                        // Consequent runs
                        const consequent = path.node.consequent;
                        if (t.isBlockStatement(consequent)) {
                            path.replaceWithMultiple(consequent.body.map(s => t.cloneNode(s)));
                        } else {
                            path.replaceWith(t.cloneNode(consequent));
                        }
                    } else {
                        // Alternate runs or remove
                        if (path.node.alternate) {
                            const alternate = path.node.alternate;
                            if (t.isBlockStatement(alternate)) {
                                path.replaceWithMultiple(alternate.body.map(s => t.cloneNode(s)));
                            } else {
                                path.replaceWith(t.cloneNode(alternate));
                            }
                        } else {
                            path.remove();
                        }
                    }
                    simplified = true;
                    changed = true;
                }
            }
        });
    }

    // 4. Remove unreferenced dummy functions
    traverse(ast, {
        FunctionDeclaration(path) {
            if (path.node.id && dummyFunctions.has(path.node.id.name)) {
                const binding = path.scope.getBinding(path.node.id.name);
                if (!binding || binding.references === 0) {
                    path.remove();
                    changed = true;
                }
            }
        }
    });

    return changed;
}

module.exports = {
    simplifyOpaquePredicates
};
