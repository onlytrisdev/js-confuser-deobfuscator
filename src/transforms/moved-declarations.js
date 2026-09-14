const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

function simplifyMovedDeclarations(ast) {
    let changed = false;

    traverse(ast, {
        IfStatement(path) {
            // Pattern: if (!fnName) { fnName = function(...) { ... }; }
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

                if (assignExpr && t.isAssignmentExpression(assignExpr) &&
                    t.isIdentifier(assignExpr.left, { name: fnName }) &&
                    (t.isFunctionExpression(assignExpr.right) || t.isArrowFunctionExpression(assignExpr.right))) {
                    
                    const fnExpr = assignExpr.right;
                    const fnDecl = t.functionDeclaration(
                        t.identifier(fnName),
                        fnExpr.params,
                        t.isBlockStatement(fnExpr.body) ? fnExpr.body : t.blockStatement([t.returnStatement(fnExpr.body)]),
                        fnExpr.generator,
                        fnExpr.async
                    );

                    // Remove fnName from parent function params if present
                    const parentFn = path.getFunctionParent();
                    if (parentFn) {
                        const params = parentFn.node.params;
                        const idx = params.findIndex(p => t.isIdentifier(p, { name: fnName }));
                        if (idx !== -1) {
                            params.splice(idx, 1);
                        }
                    }

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
