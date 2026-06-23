const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

function isBoilerplateConstant(node, boilerplateDataVars, candidateCallees) {
    if (!node) return false;
    if (t.isLiteral(node)) return true;
    if (t.isUnaryExpression(node)) {
        return isBoilerplateConstant(node.argument, boilerplateDataVars, candidateCallees);
    }
    if (t.isBinaryExpression(node)) {
        return isBoilerplateConstant(node.left, boilerplateDataVars, candidateCallees) && isBoilerplateConstant(node.right, boilerplateDataVars, candidateCallees);
    }
    if (t.isMemberExpression(node)) {
        if (t.isIdentifier(node.object) && boilerplateDataVars.has(node.object.name)) {
            return isBoilerplateConstant(node.property, boilerplateDataVars, candidateCallees);
        }
    }
    if (t.isCallExpression(node) && t.isIdentifier(node.callee)) {
        const calleeName = node.callee.name;
        if (candidateCallees && candidateCallees.has(calleeName)) {
            return node.arguments.every(arg => isBoilerplateConstant(arg, boilerplateDataVars, candidateCallees));
        }
    }
    return false;
}

function matchesRetrievePattern(node) {
    if (node.params.length === 2 && t.isIdentifier(node.params[0]) && t.isIdentifier(node.params[1])) {
        const p1 = node.params[0].name;
        const p2 = node.params[1].name;
        let bodyBlock = null;
        if (t.isBlockStatement(node.body)) {
            bodyBlock = node.body.body;
        } else {
            bodyBlock = [t.returnStatement(node.body)];
        }
        if (bodyBlock.length === 1 && t.isReturnStatement(bodyBlock[0])) {
            const ret = bodyBlock[0].argument;
            if (t.isCallExpression(ret) && ret.arguments.length === 1) {
                const innerCall = ret.arguments[0];
                if (t.isCallExpression(innerCall) && innerCall.arguments.length === 2) {
                    const arg1 = innerCall.arguments[0];
                    const arg2 = innerCall.arguments[1];
                    if (t.isIdentifier(arg1) && arg1.name === p1) {
                        if (t.isBinaryExpression(arg2) && arg2.operator === '+') {
                            const leftName = t.isIdentifier(arg2.left) ? arg2.left.name : null;
                            const rightName = t.isIdentifier(arg2.right) ? arg2.right.name : null;
                            if (leftName === p1 && rightName === p2 || leftName === p2 && rightName === p1) {
                                return true;
                            }
                        }
                    }
                }
            }
        }
    }
    return false;
}

function isBoilerplateHelper(name, bindings) {
    const binding = bindings.get(name);
    if (!binding || !binding.node) return false;
    let funcNode = null;
    if (binding.type === 'func') {
        funcNode = binding.node;
    } else if (binding.type === 'var') {
        const init = binding.node.init;
        if (init && (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))) {
            funcNode = init;
        }
    }
    if (!funcNode) return false;
    let isUser = false;
    traverse(funcNode, {
        noScope: true,
        Loop(pathNode) {
            isUser = true;
            pathNode.stop();
        },
        SwitchStatement(pathNode) {
            isUser = true;
            pathNode.stop();
        },
        TryStatement(pathNode) {
            isUser = true;
            pathNode.stop();
        },
        LabeledStatement(pathNode) {
            isUser = true;
            pathNode.stop();
        }
    });
    if (isUser) return false;
    let bodyBlock = funcNode.body;
    if (t.isBlockStatement(bodyBlock)) {
        let nonTrivialCount = 0;
        bodyBlock.body.forEach(stmt => {
            if (!t.isEmptyStatement(stmt)) nonTrivialCount++;
        });
        if (nonTrivialCount > 5) return false;
    }
    return true;
}

function isArgumentSafeForSandbox(argNode, visitedSet, safeGlobalsSet) {
    let safe = true;

    function walk(n) {
        if (!safe) return;
        if (t.isIdentifier(n)) {
            const name = n.name;
            if (!visitedSet.has(name) && !safeGlobalsSet.has(name)) {
                safe = false;
            }
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
    walk(argNode);
    return safe;
}
module.exports = {
    isBoilerplateConstant,
    matchesRetrievePattern,
    isBoilerplateHelper,
    isArgumentSafeForSandbox
};