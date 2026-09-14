const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generator = require('@babel/generator').default;
const t = require('@babel/types');

function unpack(code) {
    let currentCode = code;
    let unpacked = true;
    let layers = 0;
    while (unpacked && layers < 10) {
        unpacked = false;
        let ast;
        try {
            ast = parser.parse(currentCode, {
                sourceType: 'module',
                allowReturnOutsideFunction: true,
                plugins: ['jsx', 'typescript']
            });
        } catch (e) {
            break;
        }

        let targetCall = null;
        const prependNodes = [];

        for (const stmt of ast.program.body) {
            if (t.isExpressionStatement(stmt) && t.isCallExpression(stmt.expression)) {
                const call = stmt.expression;
                let callee = call.callee;
                while (t.isParenthesizedExpression(callee)) {
                    callee = callee.expression;
                }
                if ((t.isCallExpression(callee) || t.isNewExpression(callee))) {
                    let innerCallee = callee.callee;
                    while (t.isParenthesizedExpression(innerCallee)) {
                        innerCallee = innerCallee.expression;
                    }
                    if (t.isIdentifier(innerCallee) && innerCallee.name === 'Function') {
                        targetCall = call;
                        break;
                    }
                }
            }
            prependNodes.push(stmt);
        }

        if (targetCall) {
            let funcCall = targetCall.callee;
            while (t.isParenthesizedExpression(funcCall)) {
                funcCall = funcCall.expression;
            }
            const funcArgs = funcCall.arguments;
            const outerArgs = targetCall.arguments;

            if (funcArgs.length >= 2 && t.isStringLiteral(funcArgs[funcArgs.length - 1])) {
                const innerCode = funcArgs[funcArgs.length - 1].value;
                const objParamNode = funcArgs[0];
                const objName = t.isStringLiteral(objParamNode) ? objParamNode.value :
                                t.isIdentifier(objParamNode) ? objParamNode.name : null;
                const objExpr = outerArgs[0];

                const getMap = new Map();
                const typeofMap = new Map();

                if (objExpr && t.isObjectExpression(objExpr)) {
                    for (const prop of objExpr.properties) {
                        const key = (prop.key && t.isStringLiteral(prop.key)) ? prop.key.value :
                                    (prop.key && t.isIdentifier(prop.key)) ? prop.key.name : null;
                        if (!key) continue;

                        if (t.isObjectMethod(prop)) {
                            const body = prop.body.body;
                            if (body.length === 1 && t.isReturnStatement(body[0])) {
                                const retArg = body[0].argument;
                                if (t.isUnaryExpression(retArg) && retArg.operator === 'typeof' && t.isIdentifier(retArg.argument)) {
                                    typeofMap.set(key, retArg.argument.name);
                                } else if (t.isIdentifier(retArg)) {
                                    getMap.set(key, retArg.name);
                                }
                            }
                        } else if (t.isObjectProperty(prop)) {
                            if (t.isIdentifier(prop.value)) {
                                getMap.set(key, prop.value.name);
                            }
                        }
                    }
                }

                let innerAst;
                try {
                    innerAst = parser.parse(innerCode, {
                        sourceType: 'module',
                        allowReturnOutsideFunction: true,
                        plugins: ['jsx', 'typescript']
                    });
                } catch (e) {
                    break;
                }

                if (objName) {
                    traverse(innerAst, {
                        MemberExpression(path) {
                            if (t.isIdentifier(path.node.object) && path.node.object.name === objName) {
                                const propNode = path.node.property;
                                const key = (path.node.computed && t.isStringLiteral(propNode)) ? propNode.value :
                                            (!path.node.computed && t.isIdentifier(propNode)) ? propNode.name : null;
                                if (key) {
                                    if (typeofMap.has(key)) {
                                        path.replaceWith(t.unaryExpression('typeof', t.identifier(typeofMap.get(key))));
                                    } else if (getMap.has(key)) {
                                        path.replaceWith(t.identifier(getMap.get(key)));
                                    }
                                }
                            }
                        }
                    });
                }

                // Unwrap last return if top level
                const last = innerAst.program.body[innerAst.program.body.length - 1];
                if (last && t.isReturnStatement(last) && last.argument) {
                    innerAst.program.body[innerAst.program.body.length - 1] = t.expressionStatement(last.argument);
                }

                if (prependNodes.length > 0) {
                    innerAst.program.body.unshift(...prependNodes);
                }

                currentCode = generator(innerAst).code;
                unpacked = true;
                layers++;
            } else if (funcArgs.length === 1 && t.isStringLiteral(funcArgs[0])) {
                const innerCode = funcArgs[0].value;
                let innerAst;
                try {
                    innerAst = parser.parse(innerCode, {
                        sourceType: 'module',
                        allowReturnOutsideFunction: true,
                        plugins: ['jsx', 'typescript']
                    });
                } catch (e) {
                    break;
                }

                const last = innerAst.program.body[innerAst.program.body.length - 1];
                if (last && t.isReturnStatement(last) && last.argument) {
                    innerAst.program.body[innerAst.program.body.length - 1] = t.expressionStatement(last.argument);
                }

                if (prependNodes.length > 0) {
                    innerAst.program.body.unshift(...prependNodes);
                }

                currentCode = generator(innerAst).code;
                unpacked = true;
                layers++;
            }
        }
    }
    return currentCode;
}

module.exports = {
    unpack
};
