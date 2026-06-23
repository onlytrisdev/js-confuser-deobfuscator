const generator = require('@babel/generator').default;
const t = require('@babel/types');
const safeGlobals = new Set(['console', 'window', 'global', 'globalThis', 'document', 'process', 'Math', 'Uint8Array', 'String', 'Array', 'TextDecoder', 'TextEncoder', 'Buffer', 'Symbol', 'Object', 'Function', 'RegExp', 'Date', 'eval', 'JSON', 'undefined', 'NaN', 'Infinity', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Reflect']);

function isTopLevel(pathNode) {
    let parent = pathNode.parentPath;
    while (parent) {
        if (parent.isProgram()) return true;
        if (parent.isFunction() || parent.isLoop() || parent.isSwitchStatement() || parent.isObjectExpression() || parent.isArrayExpression()) {
            return false;
        }
        parent = parent.parentPath;
    }
    return false;
}

function isExpressionSafe(pathNode, allNames, globalsSet = safeGlobals) {
    if (!pathNode || !pathNode.node) return true;
    let isSafe = true;

    function checkId(idPath) {
        if (!isSafe) return;
        if (idPath.isReferencedIdentifier()) {
            const name = idPath.node.name;
            if (!allNames.has(name) && !globalsSet.has(name)) {
                const binding = idPath.scope.getBinding(name);
                if (binding) {
                    let curr = binding.path;
                    let declaredInside = false;
                    while (curr) {
                        if (curr.node === pathNode.node) {
                            declaredInside = true;
                            break;
                        }
                        curr = curr.parentPath;
                    }
                    if (!declaredInside) {
                        isSafe = false;
                    }
                } else {
                    isSafe = false;
                }
            }
        }
    }
    if (pathNode.isIdentifier()) {
        checkId(pathNode);
    } else {
        pathNode.traverse({
            Identifier(idPath) {
                checkId(idPath);
            }
        });
    }
    return isSafe;
}

function numericToAST(val) {
    if (typeof val === 'number') {
        if (Object.is(val, -0)) {
            return t.unaryExpression('-', t.numericLiteral(0));
        }
        if (!isFinite(val) || isNaN(val)) {
            return t.valueToNode(val);
        }
        if (val < 0) {
            return t.unaryExpression('-', t.numericLiteral(-val));
        }
        return t.numericLiteral(val);
    }
    return t.valueToNode(val);
}

function getReferencedTopLevelNames(node, allNames) {
    const refs = new Set();

    function walk(n, parent, key) {
        if (!n) return;
        if (t.isIdentifier(n)) {
            if (parent && t.isMemberExpression(parent) && key === 'property' && !parent.computed) {
                return;
            }
            if (parent && t.isObjectProperty(parent) && key === 'key' && !parent.computed) {
                return;
            }
            const name = n.name;
            if (allNames.has(name)) {
                refs.add(name);
            }
        }
        for (const k in n) {
            if (n[k] && typeof n[k] === 'object') {
                if (Array.isArray(n[k])) {
                    n[k].forEach(child => walk(child, n, k));
                } else if (typeof n[k].type === 'string') {
                    walk(n[k], n, k);
                }
            }
        }
    }
    walk(node, null, null);
    return refs;
}

function getFunctionNodeName(funcPath) {
    if (!funcPath) return null;
    const node = funcPath.node;
    if (node.id && t.isIdentifier(node.id)) {
        return node.id.name;
    }
    let parentPath = funcPath.parentPath;
    while (parentPath) {
        if (parentPath.isVariableDeclarator() && t.isIdentifier(parentPath.node.id)) {
            return parentPath.node.id.name;
        }
        if (parentPath.isAssignmentExpression() && t.isIdentifier(parentPath.node.left)) {
            return parentPath.node.left.name;
        }
        if (parentPath.isObjectProperty() && t.isIdentifier(parentPath.node.key)) {
            return parentPath.node.key.name;
        }
        if (parentPath.isFunction() || parentPath.isStatement()) {
            break;
        }
        parentPath = parentPath.parentPath;
    }
    return null;
}

function getParentFunctionNames(pathNode) {
    const names = [];
    let currentPath = pathNode;
    while (currentPath) {
        const parentFunc = currentPath.getFunctionParent();
        if (!parentFunc) break;
        const name = getFunctionNodeName(parentFunc);
        if (name) {
            names.push(name);
        }
        currentPath = parentFunc;
    }
    return names;
}

function hoistVars(pathNode) {
    if (!pathNode || !pathNode.node) return;
    const varsToHoist = [];
    pathNode.traverse({
        VariableDeclaration(p) {
            if (p.node.kind === 'var') {
                p.node.declarations.forEach(decl => {
                    if (t.isIdentifier(decl.id)) {
                        varsToHoist.push(decl.id.name);
                    }
                });
            }
        }
    });
    if (varsToHoist.length > 0) {
        const uniqueVars = Array.from(new Set(varsToHoist));
        const decls = uniqueVars.map(name => t.variableDeclarator(t.identifier(name)));
        pathNode.insertBefore(t.variableDeclaration('var', decls));
    }
}

function evaluateCustom(pathNode) {
    if (!pathNode || !pathNode.node) return {
        confident: false,
        value: undefined
    };
    if (pathNode.isBinaryExpression({
            operator: 'in'
        })) {
        const left = pathNode.node.left;
        const right = pathNode.node.right;
        if (t.isStringLiteral(left) && t.isIdentifier(right)) {
            const binding = pathNode.scope.getBinding(right.name);
            if (binding && binding.path.isFunctionDeclaration()) {
                const funcNode = binding.path.node;
                if (funcNode.params.length === 0 && funcNode.body.body.length === 0) {
                    return {
                        confident: true,
                        value: false
                    };
                }
            }
        }
    }
    if (pathNode.isUnaryExpression({
            operator: '!'
        })) {
        const argEval = evaluateCustom(pathNode.get('argument'));
        if (argEval.confident) {
            return {
                confident: true,
                value: !argEval.value
            };
        }
    }
    if (pathNode.isBinaryExpression()) {
        const leftEval = evaluateCustom(pathNode.get('left'));
        const rightEval = evaluateCustom(pathNode.get('right'));
        if (leftEval.confident && rightEval.confident) {
            const operator = pathNode.node.operator;
            let val;
            try {
                if (operator === '===') val = leftEval.value === rightEval.value;
                else if (operator === '!==') val = leftEval.value !== rightEval.value;
                else if (operator === '==') val = leftEval.value == rightEval.value;
                else if (operator === '!=') val = leftEval.value != rightEval.value;
                else if (operator === '+') val = leftEval.value + rightEval.value;
                else if (operator === '-') val = leftEval.value - rightEval.value;
                else if (operator === '*') val = leftEval.value * rightEval.value;
                else if (operator === '/') val = leftEval.value / rightEval.value;
                else if (operator === '%') val = leftEval.value % rightEval.value;
                else if (operator === '<') val = leftEval.value < rightEval.value;
                else if (operator === '>') val = leftEval.value > rightEval.value;
                else if (operator === '<=') val = leftEval.value <= rightEval.value;
                else if (operator === '>=') val = leftEval.value >= rightEval.value;
                else return {
                    confident: false,
                    value: undefined
                };
                return {
                    confident: true,
                    value: val
                };
            } catch (e) {
                return {
                    confident: false,
                    value: undefined
                };
            }
        }
    }
    if (pathNode.isLogicalExpression()) {
        const leftEval = evaluateCustom(pathNode.get('left'));
        const operator = pathNode.node.operator;
        if (leftEval.confident) {
            const leftVal = leftEval.value;
            if (operator === '&&') {
                if (!leftVal) return {
                    confident: true,
                    value: false
                };
                const rightEval = evaluateCustom(pathNode.get('right'));
                if (rightEval.confident) return {
                    confident: true,
                    value: rightEval.value
                };
            } else if (operator === '||') {
                if (leftVal) return {
                    confident: true,
                    value: leftVal
                };
                const rightEval = evaluateCustom(pathNode.get('right'));
                if (rightEval.confident) return {
                    confident: true,
                    value: rightEval.value
                };
            } else if (operator === '??') {
                if (leftVal !== null && leftVal !== undefined) return {
                    confident: true,
                    value: leftVal
                };
                const rightEval = evaluateCustom(pathNode.get('right'));
                if (rightEval.confident) return {
                    confident: true,
                    value: rightEval.value
                };
            }
        }
    }
    try {
        return pathNode.evaluate();
    } catch (e) {
        return {
            confident: false,
            value: undefined
        };
    }
}

function hasSideEffects(node) {
    let sideEffect = false;

    function walk(n) {
        if (!n || sideEffect) return;
        if (t.isAssignmentExpression(n) || t.isUpdateExpression(n)) {
            sideEffect = true;
            return;
        }
        for (const k in n) {
            if (n[k] && typeof n[k] === 'object') {
                if (Array.isArray(n[k])) {
                    n[k].forEach(walk);
                } else if (typeof n[k].type === 'string') {
                    walk(n[k]);
                }
            }
        }
    }
    walk(node);
    return sideEffect;
}
module.exports = {
    safeGlobals,
    isTopLevel,
    isExpressionSafe,
    numericToAST,
    getReferencedTopLevelNames,
    getFunctionNodeName,
    getParentFunctionNames,
    hoistVars,
    evaluateCustom,
    hasSideEffects
};