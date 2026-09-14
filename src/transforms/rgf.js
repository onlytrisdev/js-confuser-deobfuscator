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

    // 1. Find all RGF arrays:
    // var rgfArray = [ rgfEval("code...") ];
    const rgfArrays = new Map();

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
                }
            }
        }
    });

    if (rgfArrays.size === 0) return false;

    // 2. Find functions that call rgfArray[index].apply(this, [rgfArray, arguments])
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

                        // Run constant array inlining and string decoding on innerAst
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

    return changed;
}

module.exports = {
    unwrapRgf
};
