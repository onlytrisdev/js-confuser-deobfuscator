const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { evaluateCustom, numericToAST } = require('../utils/ast-utils');

function extractCalculatorMap(funcNode) {
    if (!funcNode || funcNode.params.length !== 3) return null;
    const [opParam, aParam, bParam] = funcNode.params;
    if (!t.isIdentifier(opParam) || !t.isIdentifier(aParam) || !t.isIdentifier(bParam)) return null;

    const opName = opParam.name;
    const aName = aParam.name;
    const bName = bParam.name;

    const bodyStmts = funcNode.body.body;
    let switchStmt = null;
    for (const stmt of bodyStmts) {
        if (t.isSwitchStatement(stmt) && t.isIdentifier(stmt.discriminant) && stmt.discriminant.name === opName) {
            switchStmt = stmt;
            break;
        }
    }
    if (!switchStmt) return null;

    const opMap = new Map(); // caseKey -> operator ('+', '-', '*', '/')
    for (const sc of switchStmt.cases) {
        if (!sc.test || !t.isStringLiteral(sc.test)) continue;
        const key = sc.test.value;
        for (const stmt of sc.consequent) {
            if (t.isReturnStatement(stmt) && t.isBinaryExpression(stmt.argument)) {
                const bin = stmt.argument;
                if (t.isIdentifier(bin.left) && bin.left.name === aName &&
                    t.isIdentifier(bin.right) && bin.right.name === bName) {
                    opMap.set(key, bin.operator);
                    break;
                }
            }
        }
    }

    if (opMap.size === 0) return null;
    return opMap;
}

function inlineCalculator(ast) {
    let changed = false;
    const calculators = new Map(); // fnName -> opMap

    traverse(ast, {
        FunctionDeclaration(path) {
            if (path.node.id) {
                const map = extractCalculatorMap(path.node);
                if (map) {
                    calculators.set(path.node.id.name, {
                        path: path,
                        map: map
                    });
                }
            }
        }
    });

    if (calculators.size === 0) return false;

    traverse(ast, {
        CallExpression(path) {
            if (t.isIdentifier(path.node.callee) && calculators.has(path.node.callee.name)) {
                const calcInfo = calculators.get(path.node.callee.name);
                const args = path.node.arguments;
                if (args.length === 3) {
                    let opKey = null;
                    if (t.isStringLiteral(args[0])) {
                        opKey = args[0].value;
                    } else {
                        const evalRes = evaluateCustom(path.get('arguments.0'));
                        if (evalRes.confident && typeof evalRes.value === 'string') {
                            opKey = evalRes.value;
                        }
                    }

                    if (opKey && calcInfo.map.has(opKey)) {
                        const operator = calcInfo.map.get(opKey);
                        const left = args[1];
                        const right = args[2];

                        // Constant fold if both left and right are numeric literals
                        if (t.isNumericLiteral(left) && t.isNumericLiteral(right)) {
                            let val;
                            if (operator === '+') val = left.value + right.value;
                            else if (operator === '-') val = left.value - right.value;
                            else if (operator === '*') val = left.value * right.value;
                            else if (operator === '/') val = left.value / right.value;
                            if (val !== undefined && isFinite(val) && !isNaN(val)) {
                                path.replaceWith(numericToAST(val));
                                changed = true;
                                return;
                            }
                        }

                        path.replaceWith(t.binaryExpression(operator, t.cloneNode(left), t.cloneNode(right)));
                        changed = true;
                    }
                }
            }
        }
    });

    // Remove calculator function declarations if no longer referenced
    for (const [name, info] of calculators.entries()) {
        const binding = info.path.scope.getBinding(name);
        if (binding && binding.referencePaths.length === 0) {
            info.path.remove();
            changed = true;
        }
    }

    return changed;
}

module.exports = {
    inlineCalculator
};
