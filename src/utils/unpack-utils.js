const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generator = require('@babel/generator').default;
const {
    isTopLevel
} = require('./ast-utils');

function detectGlobalInjects(code) {
    const bindings = [];
    try {
        const ast = parser.parse(code, {
            sourceType: 'module',
            allowReturnOutsideFunction: true,
            plugins: ['jsx', 'typescript']
        });
        traverse(ast, {
            CallExpression(pathNode) {
                if (!isTopLevel(pathNode)) return;
                let callee = pathNode.node.callee;
                while (t.isParenthesizedExpression(callee)) {
                    callee = callee.expression;
                }
                if ((t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) && callee.params.length >= 1 && pathNode.node.arguments.length >= 1) {
                    const params = callee.params;
                    const args = pathNode.node.arguments;
                    for (let i = 0; i < Math.min(params.length, args.length); i++) {
                        const param = params[i];
                        const arg = args[i];
                        if (t.isIdentifier(param)) {
                            const {
                                code: argCode
                            } = generator(arg);
                            bindings.push({
                                name: param.name,
                                code: argCode
                            });
                            console.log(`[+] Found IIFE Global Inject Param: '${param.name}' = ${argCode}`);
                        }
                    }
                }
                if (t.isCallExpression(callee) || t.isNewExpression(callee)) {
                    let innerCallee = callee.callee;
                    while (t.isParenthesizedExpression(innerCallee)) {
                        innerCallee = innerCallee.expression;
                    }
                    if (t.isIdentifier(innerCallee) && innerCallee.name === 'Function') {
                        const innerArgs = callee.arguments;
                        if (innerArgs.length >= 2 && pathNode.node.arguments.length >= 1) {
                            const params = innerArgs.slice(0, -1);
                            const outerArgs = pathNode.node.arguments;
                            for (let i = 0; i < Math.min(params.length, outerArgs.length); i++) {
                                const paramArg = params[i];
                                const outerArg = outerArgs[i];
                                if (t.isStringLiteral(paramArg)) {
                                    const paramName = paramArg.value;
                                    const {
                                        code: argCode
                                    } = generator(outerArg);
                                    bindings.push({
                                        name: paramName,
                                        code: argCode
                                    });
                                    console.log(`[+] Found Function Constructor Global Inject Param: '${paramName}' = ${argCode}`);
                                }
                            }
                        }
                    }
                }
            }
        });
    } catch (e) {}
    return bindings;
}

function unpackCode(code) {
    let currentCode = code;
    let unpacked = true;
    let layer = 0;
    while (unpacked) {
        unpacked = false;
        try {
            const tempAst = parser.parse(currentCode, {
                sourceType: 'module',
                allowReturnOutsideFunction: true,
                plugins: ['jsx', 'typescript']
            });
            if (tempAst.program.body.length === 1) {
                const node = tempAst.program.body[0];
                if (t.isExpressionStatement(node) && t.isCallExpression(node.expression)) {
                    const call = node.expression;
                    let funcNode = null;
                    if (t.isCallExpression(call.callee)) {
                        funcNode = call.callee;
                    } else if (t.isNewExpression(call.callee)) {
                        funcNode = call.callee;
                    }
                    if (funcNode && t.isIdentifier(funcNode.callee) && funcNode.callee.name === 'Function') {
                        const args = funcNode.arguments;
                        if (args.length >= 1 && t.isStringLiteral(args[args.length - 1])) {
                            currentCode = args[args.length - 1].value;
                            unpacked = true;
                            layer++;
                            console.log(`[+] Unpacked RGF wrapper layer ${layer} (new code size: ${currentCode.length} chars)`);
                            continue;
                        }
                    }
                }
            }
        } catch (e) {}
    }
    return currentCode;
}
module.exports = {
    detectGlobalInjects,
    unpackCode
};