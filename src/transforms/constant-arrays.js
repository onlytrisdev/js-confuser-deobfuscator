const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const { numericToAST, evaluateCustom } = require('../utils/ast-utils');

function isLiteralOrConstant(node) {
    if (!node) return false;
    if (t.isLiteral(node)) return true;
    if (t.isNullLiteral(node)) return true;
    if (t.isIdentifier(node) && (node.name === 'undefined' || node.name === 'NaN' || node.name === 'Infinity')) return true;
    if (t.isUnaryExpression(node) && (node.operator === '-' || node.operator === '+' || node.operator === '!' || node.operator === 'void')) {
        return isLiteralOrConstant(node.argument);
    }
    return false;
}

function inlineConstantArrays(ast) {
    let changed = false;
    let keepRunning = true;
    let pass = 0;

    while (keepRunning && pass < 10) {
        keepRunning = false;
        pass++;

        // Find constant array declarators
        const constantArrays = new Map(); // name -> elements array

        traverse(ast, {
            VariableDeclarator(path) {
                if (t.isIdentifier(path.node.id) && path.node.init && t.isArrayExpression(path.node.init)) {
                    const name = path.node.id.name;
                    const binding = path.scope.getBinding(name);
                    if (!binding || !binding.constant) return;

                    const elements = path.node.init.elements;
                    // Check that elements are literals or simple expressions
                    if (elements.every(el => el && isLiteralOrConstant(el))) {
                        const MUTATING_METHODS = new Set(['push', 'pop', 'shift', 'unshift', 'splice', 'reverse', 'sort', 'fill', 'copyWithin']);
                        let isMutated = false;
                        for (const refPath of binding.referencePaths) {
                            const parent = refPath.parentPath;
                            if (!parent || !parent.isMemberExpression() || parent.node.object !== refPath.node) {
                                isMutated = true;
                                break;
                            }
                            const grandParent = parent.parentPath;
                            if (grandParent) {
                                if (grandParent.isAssignmentExpression() && grandParent.node.left === parent.node) {
                                    isMutated = true;
                                    break;
                                }
                                if (grandParent.isUpdateExpression()) {
                                    isMutated = true;
                                    break;
                                }
                                if (grandParent.isCallExpression() && grandParent.node.callee === parent.node) {
                                    const propNode = parent.node.property;
                                    const propName = parent.node.computed 
                                        ? (t.isStringLiteral(propNode) ? propNode.value : null) 
                                        : (t.isIdentifier(propNode) ? propNode.name : null);
                                    if (!propName || MUTATING_METHODS.has(propName)) {
                                        isMutated = true;
                                        break;
                                    }
                                }
                            }
                        }
                        if (!isMutated) {
                            constantArrays.set(name, {
                                path: path,
                                binding: binding,
                                elements: elements
                            });
                        }
                    }
                }
            }
        });

        if (constantArrays.size === 0) break;

        // Replace member expressions: arr[index]
        traverse(ast, {
            MemberExpression(path) {
                if (t.isIdentifier(path.node.object) && constantArrays.has(path.node.object.name)) {
                    const arrayInfo = constantArrays.get(path.node.object.name);
                    const binding = path.scope.getBinding(path.node.object.name);
                    if (binding !== arrayInfo.binding) return;

                    const prop = path.node.property;
                    let index = null;

                    if (!path.node.computed && t.isIdentifier(prop) && prop.name === 'length') {
                        path.replaceWith(t.numericLiteral(arrayInfo.elements.length));
                        changed = true;
                        keepRunning = true;
                        return;
                    }

                    if (path.node.computed) {
                        if (t.isNumericLiteral(prop)) {
                            index = prop.value;
                        } else if (t.isStringLiteral(prop) && /^\d+$/.test(prop.value)) {
                            index = parseInt(prop.value, 10);
                        } else {
                            // Try evaluating constant expression for property
                            const evalResult = evaluateCustom(path.get('property'));
                            if (evalResult.confident && typeof evalResult.value === 'number') {
                                index = evalResult.value;
                            }
                        }

                        if (index !== null && index >= 0 && index < arrayInfo.elements.length) {
                            const targetElement = arrayInfo.elements[index];
                            if (targetElement) {
                                path.replaceWith(t.cloneNode(targetElement));
                                changed = true;
                                keepRunning = true;
                            }
                        }
                    }
                }
            }
        });

        // Fold binary expressions and literals
        traverse(ast, {
            BinaryExpression(path) {
                const { left, right, operator } = path.node;
                if (t.isNumericLiteral(left) && t.isNumericLiteral(right)) {
                    let val;
                    if (operator === '+') val = left.value + right.value;
                    else if (operator === '-') val = left.value - right.value;
                    else if (operator === '*') val = left.value * right.value;
                    else if (operator === '/') val = left.value / right.value;
                    else if (operator === '%') val = left.value % right.value;
                    else if (operator === '<<') val = left.value << right.value;
                    else if (operator === '>>') val = left.value >> right.value;
                    else if (operator === '>>>') val = left.value >>> right.value;
                    else if (operator === '&') val = left.value & right.value;
                    else if (operator === '|') val = left.value | right.value;
                    else if (operator === '^') val = left.value ^ right.value;
                    else return;
                    if (isFinite(val) && !isNaN(val)) {
                        path.replaceWith(numericToAST(val));
                        changed = true;
                        keepRunning = true;
                    }
                } else if (operator === '+' && t.isStringLiteral(left) && t.isStringLiteral(right)) {
                    path.replaceWith(t.stringLiteral(left.value + right.value));
                    changed = true;
                    keepRunning = true;
                }
            }
        });
    }

    return changed;
}

module.exports = {
    inlineConstantArrays
};
