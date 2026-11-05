const t = require('@babel/types');

const safeGlobals = new Set([
    'console', 'Math', 'Object', 'Array', 'String', 'Number', 'Boolean', 'Date', 'RegExp',
    'Error', 'TypeError', 'RangeError', 'SyntaxError', 'ReferenceError', 'URIError', 'EvalError',
    'JSON', 'Promise', 'Symbol', 'Map', 'Set', 'WeakMap', 'WeakSet', 'Proxy', 'Reflect',
    'Int8Array', 'Uint8Array', 'Uint8ClampedArray', 'Int16Array', 'Uint16Array', 'Int32Array',
    'Uint32Array', 'Float32Array', 'Float64Array', 'BigInt64Array', 'BigUint64Array', 'DataView',
    'ArrayBuffer', 'SharedArrayBuffer', 'Buffer', 'TextDecoder', 'TextEncoder', 'URL',
    'URLSearchParams', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval',
    'setImmediate', 'clearImmediate', 'queueMicrotask', 'parseInt', 'parseFloat', 'isNaN',
    'isFinite', 'decodeURI', 'decodeURIComponent', 'encodeURI', 'encodeURIComponent', 'escape',
    'unescape', 'eval', 'Function', 'BigInt', 'Intl', 'WebAssembly', 'process', 'global',
    'globalThis', 'window', 'document', 'navigator', 'location', 'fetch', 'Headers', 'Request',
    'Response', 'AbortController', 'crypto', 'performance', 'atob', 'btoa',
    'undefined', 'NaN', 'Infinity'
]);

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
    if (pathNode.isUnaryExpression({
            operator: 'void'
        })) {
        return {
            confident: true,
            value: undefined
        };
    }
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

module.exports = {
    safeGlobals,
    numericToAST,
    hoistVars,
    evaluateCustom
};