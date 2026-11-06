const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');

const { inlineConstantArrays } = require('./constant-arrays');
const { decodeStrings } = require('./string-concealing');

function evalStr(n) {
    if (!n) return null;
    if (t.isStringLiteral(n)) return n.value;
    if (t.isBinaryExpression(n) && n.operator === '+') {
        const l = evalStr(n.left);
        const r = evalStr(n.right);
        if (l !== null && r !== null) return l + r;
    }
    return null;
}

function unwrapRgf(ast) {
    let changed = false;

    const rgfArrays = new Map();
    const rgfDeclarators = new Map();

    traverse(ast, {
        VariableDeclarator(path) {
            if (t.isIdentifier(path.node.id) && path.node.init && t.isArrayExpression(path.node.init)) {
                const arrName = path.node.id.name;
                const elements = path.node.init.elements;
                const codeStrings = [];
                let isRgf = false;

                for (const el of elements) {
                    if (el && t.isCallExpression(el) && el.arguments.length === 1) {
                        const s = evalStr(el.arguments[0]);
                        if (s !== null) {
                            codeStrings.push(s);
                            isRgf = true;
                        }
                    } else if (el) {
                        const s = evalStr(el);
                        if (s !== null) {
                            codeStrings.push(s);
                            isRgf = true;
                        }
                    }
                }

                if (isRgf && codeStrings.length > 0) {
                    rgfArrays.set(arrName, codeStrings);
                    rgfDeclarators.set(arrName, path);
                }
            }
        }
    });

    if (rgfArrays.size === 0) return false;

    traverse(ast, {
        Function(fnPath) {
            let rgfMatch = null;
            fnPath.traverse({
                ReturnStatement(retPath) {
                    if (retPath.getFunctionParent() !== fnPath) return;
                    const arg = retPath.node.argument;
                    if (t.isCallExpression(arg) && t.isMemberExpression(arg.callee)) {
                        const mem = arg.callee;
                        const prop = mem.property;
                        const isApply = (t.isIdentifier(prop, { name: 'apply' })) ||
                                        (t.isStringLiteral(prop, { value: 'apply' }));
                        if (isApply && t.isMemberExpression(mem.object)) {
                            const innerMem = mem.object;
                            if (t.isIdentifier(innerMem.object) && rgfArrays.has(innerMem.object.name)) {
                                const arrName = innerMem.object.name;
                                let idx = null;
                                if (t.isNumericLiteral(innerMem.property)) {
                                    idx = innerMem.property.value;
                                }
                                if (idx !== null) {
                                    rgfMatch = { arrName, idx };
                                    retPath.stop();
                                }
                            }
                        }
                    }
                }
            });

            if (rgfMatch) {
                const { arrName, idx } = rgfMatch;
                const codeList = rgfArrays.get(arrName);
                if (codeList && codeList[idx]) {
                    const codeString = codeList[idx];
                    try {
                        const innerAst = parser.parse(codeString, {
                            sourceType: 'module',
                            allowReturnOutsideFunction: true,
                            plugins: ['jsx', 'typescript']
                        });

                        inlineConstantArrays(innerAst);
                        decodeStrings(innerAst);
                        inlineConstantArrays(innerAst);

                        let replacementFn = null;
                        traverse(innerAst, {
                            FunctionDeclaration(ip) {
                                if (ip.node.id && ip.node.id.name.includes('replacement')) {
                                    replacementFn = ip.node;
                                    ip.stop();
                                }
                            }
                        });

                        if (!replacementFn) {
                            traverse(innerAst, {
                                FunctionDeclaration(ip) {
                                    if (ip.parentPath.isBlockStatement() && ip.parentPath.parentPath.isFunctionDeclaration()) {
                                        replacementFn = ip.node;
                                        ip.stop();
                                    }
                                }
                            });
                        }

                        if (!replacementFn) {
                            traverse(innerAst, {
                                FunctionDeclaration(ip) {
                                    replacementFn = ip.node;
                                    ip.stop();
                                }
                            });
                        }

                        if (replacementFn) {
                            fnPath.node.params = replacementFn.params;
                            fnPath.node.body = replacementFn.body;
                            changed = true;
                        }
                    } catch (e) {}
                }
            }
        }
    });

    if (changed) {
        for (const [arrName, declPath] of rgfDeclarators.entries()) {
            let refCount = 0;
            traverse(ast, {
                Identifier(idPath) {
                    if (idPath.node.name === arrName && idPath.node !== declPath.node.id) {
                        refCount++;
                    }
                }
            });
            if (refCount === 0 && !declPath.removed) {
                const evalCalleeNames = new Set();
                for (const el of declPath.node.init.elements) {
                    if (el && t.isCallExpression(el) && t.isIdentifier(el.callee)) {
                        evalCalleeNames.add(el.callee.name);
                    }
                }
                declPath.remove();
                for (const calleeName of evalCalleeNames) {
                    let calleeRefs = 0;
                    let calleeFnPath = null;
                    traverse(ast, {
                        FunctionDeclaration(fp) {
                            if (fp.node.id && fp.node.id.name === calleeName) {
                                calleeFnPath = fp;
                            }
                        },
                        Identifier(idPath) {
                            if (idPath.node.name === calleeName) {
                                if (idPath.parentPath.isFunctionDeclaration() && idPath.parentPath.node.id === idPath.node) {
                                    return;
                                }
                                calleeRefs++;
                            }
                        }
                    });
                    if (calleeRefs === 0 && calleeFnPath && !calleeFnPath.removed) {
                        calleeFnPath.remove();
                    }
                }
            }
        }
    }

    return changed;
}

module.exports = {
    unwrapRgf
};
