const traverse = require('@babel/traverse').default;
const generator = require('@babel/generator').default;
const t = require('@babel/types');
const { numericToAST, evaluateCustom } = require('../utils/ast-utils');

let nodeVm = null;
try {
    nodeVm = require('vm');
} catch (e) {}

function createSandbox(seed) {
    if (nodeVm && typeof nodeVm.createContext === 'function' && typeof nodeVm.runInContext === 'function') {
        const ctx = nodeVm.createContext(seed);
        ctx.global = ctx;
        ctx.globalThis = ctx;
        ctx.window = ctx;
        return {
            ctx,
            run(code, timeout) {
                return nodeVm.runInContext(code, ctx, { timeout });
            }
        };
    }
    const ctx = Object.assign(Object.create(null), seed);
    ctx.global = ctx;
    ctx.globalThis = ctx;
    ctx.window = ctx;
    const runner = new Function('__ctx', '__code', 'with (__ctx) { return eval(__code); }');
    return {
        ctx,
        run(code) {
            return runner(ctx, code);
        }
    };
}

function decodeStrings(ast) {
    let changed = false;

    const fakeConsole = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
    const hasFullBuffer = typeof Buffer !== 'undefined' && typeof Buffer.from === 'function';
    const sandbox = createSandbox({
        TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
        TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : undefined,
        Buffer: hasFullBuffer ? Buffer : undefined,
        String,
        Array,
        Object,
        Math,
        Uint8Array,
        global: null,
        globalThis: null,
        window: null,
        console: fakeConsole
    });
    const ctx = sandbox.ctx;

    const lookupEntries = [
        [fakeConsole, t.identifier('console')],
        [String, t.identifier('String')],
        [Array, t.identifier('Array')],
        [Object, t.identifier('Object')],
        [Math, t.identifier('Math')],
        [Uint8Array, t.identifier('Uint8Array')]
    ];
    if (typeof TextDecoder !== 'undefined') lookupEntries.push([TextDecoder, t.identifier('TextDecoder')]);
    if (typeof TextEncoder !== 'undefined') lookupEntries.push([TextEncoder, t.identifier('TextEncoder')]);
    if (hasFullBuffer) lookupEntries.push([Buffer, t.identifier('Buffer')]);
    const globalLookup = new Map(lookupEntries);

    function convertToAST(res) {
        if (typeof res === 'string') return t.stringLiteral(res);
        if (typeof res === 'number') return numericToAST(res);
        if (typeof res === 'boolean') return t.booleanLiteral(res);
        if (globalLookup.has(res)) return t.cloneNode(globalLookup.get(res));
        if (res === ctx || res === ctx.global || res === ctx.globalThis || res === ctx.window) {
            return t.identifier('globalThis');
        }
        return null;
    }

    const topLevelFnNames = new Set();
    for (const stmt of ast.program.body) {
        if (t.isFunctionDeclaration(stmt) && stmt.id) {
            topLevelFnNames.add(stmt.id.name);
        }
    }

    function isSafeCallCallee(callee, allowedFnNames) {
        if (t.isFunctionExpression(callee) || t.isArrowFunctionExpression(callee)) return true;
        if (t.isIdentifier(callee) && allowedFnNames.has(callee.name)) return true;
        if (t.isMemberExpression(callee) && t.isIdentifier(callee.object, { name: 'Object' })) {
            const prop = callee.property;
            if (t.isIdentifier(prop, { name: 'create' }) || t.isStringLiteral(prop, { value: 'create' })) {
                return true;
            }
        }
        return false;
    }

    function isSafeValueExpr(node, allowedFnNames) {
        if (!node) return false;
        if (t.isLiteral(node) || t.isIdentifier(node) || t.isMemberExpression(node) ||
            t.isLogicalExpression(node) || t.isBinaryExpression(node) || t.isUnaryExpression(node) ||
            t.isConditionalExpression(node) || t.isArrayExpression(node) || t.isObjectExpression(node) ||
            t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
            return true;
        }
        if (t.isCallExpression(node)) {
            return isSafeCallCallee(node.callee, allowedFnNames);
        }
        return false;
    }

    function isSafeAssignmentExpr(expr, allowedFnNames) {
        if (t.isAssignmentExpression(expr)) {
            return isSafeValueExpr(expr.right, allowedFnNames);
        }
        if (t.isSequenceExpression(expr)) {
            return expr.expressions.length > 0 && expr.expressions.every(e => isSafeAssignmentExpr(e, allowedFnNames));
        }
        if (t.isCallExpression(expr) && t.isIdentifier(expr.callee) && allowedFnNames.has(expr.callee.name)) {
            return expr.arguments.length > 0 && expr.arguments.every(e => isSafeAssignmentExpr(e, allowedFnNames));
        }
        return false;
    }

    function isBase91Function(fnNode) {
        if (!fnNode || !fnNode.body) return false;
        const nums = new Set();
        traverse(fnNode.body, {
            noScope: true,
            Function(fp) {
                fp.skip();
            },
            NumericLiteral(np) {
                nums.add(np.node.value);
            }
        });
        return nums.has(91) && (nums.has(8191) || nums.has(255));
    }

    function collectBase91FunctionNames(stmts) {
        const names = new Set();
        for (const s of stmts) {
            if (t.isFunctionDeclaration(s) && s.id && isBase91Function(s)) {
                names.add(s.id.name);
            } else if (t.isVariableDeclaration(s)) {
                for (const d of s.declarations) {
                    if (t.isIdentifier(d.id) && (t.isFunctionExpression(d.init) || t.isArrowFunctionExpression(d.init)) && isBase91Function(d.init)) {
                        names.add(d.id.name);
                    }
                }
            } else if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression)) {
                const { left, right } = s.expression;
                if (t.isIdentifier(left) && (t.isFunctionExpression(right) || t.isArrowFunctionExpression(right)) && isBase91Function(right)) {
                    names.add(left.name);
                }
            }
        }
        return names;
    }

    function isRetrieveFunctionNode(fnNode, base91Names) {
        if (!fnNode) return false;
        let body = null;
        if (t.isFunctionDeclaration(fnNode) || t.isFunctionExpression(fnNode) || t.isArrowFunctionExpression(fnNode)) {
            body = fnNode.body;
        }
        if (!body) return false;
        const stmts = t.isBlockStatement(body) ? body.body : [t.returnStatement(body)];
        if (stmts.length > 10) return false;

        let matched = false;
        for (const s of stmts) {
            if (t.isWhileStatement(s) || t.isForStatement(s) || t.isSwitchStatement(s) || t.isDoWhileStatement(s)) {
                return false;
            }
            if (t.isReturnStatement(s) && s.argument) {
                const retWrapper = t.file(t.program([s]));
                traverse(retWrapper, {
                    noScope: true,
                    Function(fp) {
                        fp.skip();
                    },
                    CallExpression(cp) {
                        const callee = cp.node.callee;
                        if (t.isIdentifier(callee) && base91Names && base91Names.has(callee.name)) {
                            matched = true;
                        } else if (t.isSequenceExpression(callee) && callee.expressions.length > 0) {
                            const last = callee.expressions[callee.expressions.length - 1];
                            if (t.isIdentifier(last) && base91Names && base91Names.has(last.name)) {
                                matched = true;
                            }
                        }
                    }
                });
            }
        }
        return matched;
    }

    function isRetrieveFunction(node, base91Names) {
        if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
            return isRetrieveFunctionNode(node, base91Names);
        }
        if (t.isVariableDeclarator(node) && t.isIdentifier(node.id)) {
            return isRetrieveFunctionNode(node.init, base91Names);
        }
        if (t.isAssignmentExpression(node) && t.isIdentifier(node.left)) {
            return isRetrieveFunctionNode(node.right, base91Names);
        }
        if (t.isExpressionStatement(node) && t.isAssignmentExpression(node.expression) && t.isIdentifier(node.expression.left)) {
            return isRetrieveFunctionNode(node.expression.right, base91Names);
        }
        return false;
    }

    const getGlobalFns = [];
    traverse(ast, {
        FunctionDeclaration(path) {
            if (!path.parentPath.isProgram()) return;
            if (path.node.params.length > 1) return;
            let hasGlobals = false;
            let hasLoop = false;
            let hasTry = false;

            path.traverse({
                ArrayExpression(arrPath) {
                    if (arrPath.getFunctionParent() !== path) return;
                    if (arrPath.node.elements.length >= 3) {
                        const code = generator(arrPath.node).code;
                        if (code.includes('globalThis') && code.includes('global') && (code.includes('window') || code.includes('Function'))) {
                            hasGlobals = true;
                        }
                    }
                },
                "ForStatement|WhileStatement"(loopPath) {
                    if (loopPath.getFunctionParent() === path) hasLoop = true;
                },
                TryStatement(tryPath) {
                    if (tryPath.getFunctionParent() === path) hasTry = true;
                }
            });

            if (hasGlobals && hasLoop && hasTry && path.node.id && path.node.body && path.node.body.body && path.node.body.body.length < 15) {
                getGlobalFns.push(path.node.id.name);
                path.get('body').replaceWith(t.blockStatement([
                    t.returnStatement(t.identifier('globalThis'))
                ]));
            }
        }
    });

    const declStmts = [];
    const boilerplateStmts = [];
    for (const stmt of ast.program.body) {
        if (t.isFunctionDeclaration(stmt) || t.isVariableDeclaration(stmt)) {
            declStmts.push(stmt);
            boilerplateStmts.push(stmt);
        } else if (t.isExpressionStatement(stmt) && isSafeAssignmentExpr(stmt.expression, topLevelFnNames)) {
            boilerplateStmts.push(stmt);
        }
    }

    for (const stmt of declStmts) {
        if (t.isFunctionDeclaration(stmt) && stmt.id) {
            if (!(stmt.id.name in ctx)) ctx[stmt.id.name] = undefined;
        } else if (t.isVariableDeclaration(stmt)) {
            const ids = t.getBindingIdentifiers(stmt);
            for (const name of Object.keys(ids)) {
                if (!(name in ctx)) ctx[name] = undefined;
            }
        }
    }

    for (const stmt of declStmts) {
        try {
            if (t.isFunctionDeclaration(stmt) && stmt.id) {
                const fnExpr = t.functionExpression(stmt.id, stmt.params, stmt.body, stmt.generator, stmt.async);
                const assign = t.expressionStatement(t.assignmentExpression('=', t.identifier(stmt.id.name), fnExpr));
                sandbox.run(generator(assign).code, 500);
            } else if (t.isVariableDeclaration(stmt) && stmt.kind !== 'var') {
                const varStmt = t.variableDeclaration('var', stmt.declarations);
                sandbox.run(generator(varStmt).code, 500);
            } else {
                sandbox.run(generator(stmt).code, 500);
            }
        } catch (e) {}
    }

    getGlobalFns.forEach(fn => {
        if (typeof ctx[fn] === 'undefined') {
            ctx[fn] = () => ctx;
        }
    });

    for (const stmt of boilerplateStmts) {
        if (t.isFunctionDeclaration(stmt)) continue;
        try {
            if (t.isVariableDeclaration(stmt) && stmt.kind !== 'var') {
                const varStmt = t.variableDeclaration('var', stmt.declarations);
                sandbox.run(generator(varStmt).code, 500);
            } else {
                sandbox.run(generator(stmt).code, 500);
            }
        } catch (e) {}
    }

    const topBase91Names = collectBase91FunctionNames(ast.program.body);
    const bindingToFn = new Map();

    traverse(ast, {
        "Program|BlockStatement"(path) {
            const block = path.node;
            const bodyStmts = block.body || [];
            if (bodyStmts.length === 0) return;

            const localFnNames = new Set(topLevelFnNames);
            for (const s of bodyStmts) {
                if (t.isFunctionDeclaration(s) && s.id) {
                    localFnNames.add(s.id.name);
                }
            }

            const localBase91Names = new Set([...topBase91Names, ...collectBase91FunctionNames(bodyStmts)]);
            const retrieveNames = [];

            for (const s of bodyStmts) {
                if (t.isFunctionDeclaration(s) && s.id && isRetrieveFunction(s, localBase91Names)) {
                    retrieveNames.push(s.id.name);
                } else if (t.isVariableDeclaration(s)) {
                    for (const d of s.declarations) {
                        if (t.isIdentifier(d.id) && isRetrieveFunction(d, localBase91Names)) {
                            retrieveNames.push(d.id.name);
                        }
                    }
                } else if (t.isExpressionStatement(s) && t.isAssignmentExpression(s.expression)) {
                    if (t.isIdentifier(s.expression.left) && isRetrieveFunction(s.expression, localBase91Names)) {
                        retrieveNames.push(s.expression.left.name);
                    }
                } else if (t.isIfStatement(s) && t.isUnaryExpression(s.test, { operator: '!' }) && t.isIdentifier(s.test.argument)) {
                    const conseqStmts = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
                    for (const cs of conseqStmts) {
                        if (t.isExpressionStatement(cs) && t.isAssignmentExpression(cs.expression) && t.isIdentifier(cs.expression.left)) {
                            if (isBase91Function(cs.expression.right)) {
                                localBase91Names.add(cs.expression.left.name);
                            }
                        }
                    }
                }
            }

            for (const s of bodyStmts) {
                if (t.isIfStatement(s) && t.isUnaryExpression(s.test, { operator: '!' }) && t.isIdentifier(s.test.argument)) {
                    const conseqStmts = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
                    for (const cs of conseqStmts) {
                        if (t.isExpressionStatement(cs) && t.isAssignmentExpression(cs.expression) && t.isIdentifier(cs.expression.left)) {
                            if (isRetrieveFunction(cs.expression, localBase91Names)) {
                                retrieveNames.push(cs.expression.left.name);
                            }
                        }
                    }
                }
            }

            if (retrieveNames.length === 0) return;

            const setupStmts = [];
            const parentFunc = path.isBlockStatement() && path.parentPath.isFunction() ? path.parentPath.node : null;
            if (parentFunc && parentFunc.params) {
                const paramIds = [];
                for (const p of parentFunc.params) {
                    if (t.isIdentifier(p)) paramIds.push(t.variableDeclarator(t.identifier(p.name)));
                }
                if (paramIds.length > 0) {
                    setupStmts.push(t.variableDeclaration('var', paramIds));
                }
            }

            for (const s of bodyStmts) {
                if (t.isFunctionDeclaration(s)) {
                    setupStmts.push(s);
                } else if (t.isVariableDeclaration(s)) {
                    const safeDecls = [];
                    for (const d of s.declarations) {
                        if (!d.init || isSafeValueExpr(d.init, localFnNames)) {
                            safeDecls.push(d);
                        } else if (t.isIdentifier(d.id)) {
                            safeDecls.push(t.variableDeclarator(t.identifier(d.id.name)));
                        }
                    }
                    if (safeDecls.length > 0) {
                        setupStmts.push(t.variableDeclaration('var', safeDecls));
                    }
                } else if (t.isExpressionStatement(s) && isSafeAssignmentExpr(s.expression, localFnNames)) {
                    setupStmts.push(s);
                } else if (t.isIfStatement(s) && t.isUnaryExpression(s.test, { operator: '!' }) && t.isIdentifier(s.test.argument)) {
                    const conseqStmts = t.isBlockStatement(s.consequent) ? s.consequent.body : [s.consequent];
                    for (const cs of conseqStmts) {
                        if (t.isExpressionStatement(cs) && t.isAssignmentExpression(cs.expression) && isSafeAssignmentExpr(cs.expression, localFnNames)) {
                            setupStmts.push(cs);
                        }
                    }
                }
            }

            const codeToRun = setupStmts.map(s => `try { ${generator(s).code} } catch (e) {}`).join('\n');
            const fnDeclsOnly = setupStmts.filter(s => t.isFunctionDeclaration(s)).map(s => generator(s).code).join('\n');

            for (const fnName of retrieveNames) {
                const binding = path.scope.getBinding(fnName);
                if (binding) {
                    try {
                        const iife = `(function() {\n${fnDeclsOnly}\n${codeToRun}\nreturn ${fnName};\n})()`;
                        const localFn = sandbox.run(iife, 500);
                        if (typeof localFn === 'function') {
                            bindingToFn.set(binding, localFn);
                        }
                    } catch (e) {}
                }
            }
        }
    });

    traverse(ast, {
        CallExpression(path) {
            let calleeId = null;
            if (t.isIdentifier(path.node.callee)) {
                calleeId = path.node.callee;
            } else if (t.isSequenceExpression(path.node.callee)) {
                const exprs = path.node.callee.expressions;
                if (exprs.length > 0 && t.isIdentifier(exprs[exprs.length - 1])) {
                    calleeId = exprs[exprs.length - 1];
                }
            }
            if (!calleeId) return;

            const name = calleeId.name;
            const binding = path.scope.getBinding(name);
            if (!binding) return;
            const decoder = bindingToFn.get(binding);
            if (!decoder) return;

            const args = [];
            let ok = true;
            for (let i = 0; i < path.node.arguments.length; i++) {
                const arg = path.node.arguments[i];
                if (t.isNumericLiteral(arg)) {
                    args.push(arg.value);
                } else if (t.isStringLiteral(arg)) {
                    args.push(arg.value);
                } else if (t.isUnaryExpression(arg) && arg.operator === '-' && t.isNumericLiteral(arg.argument)) {
                    args.push(-arg.argument.value);
                } else {
                    const evalRes = evaluateCustom(path.get(`arguments.${i}`));
                    if (evalRes.confident && (typeof evalRes.value === 'number' || typeof evalRes.value === 'string')) {
                        args.push(evalRes.value);
                    } else {
                        ok = false;
                        break;
                    }
                }
            }
            if (!ok || args.length === 0) return;

            try {
                ctx.__currDecoder = decoder;
                ctx.__currArgs = args;
                const res = sandbox.run('__currDecoder(...__currArgs)', 200);
                const astNode = convertToAST(res);
                if (astNode) {
                    path.replaceWith(astNode);
                    changed = true;
                }
            } catch (e) {}
        }
    });

    traverse(ast, {
        BinaryExpression: {
            exit(path) {
                if (path.node.operator !== '+') return;
                const left = path.node.left;
                const right = path.node.right;
                if (t.isStringLiteral(left) && t.isStringLiteral(right)) {
                    path.replaceWith(t.stringLiteral(left.value + right.value));
                    changed = true;
                } else if (t.isBinaryExpression(left, { operator: '+' }) &&
                    t.isStringLiteral(left.right) &&
                    t.isStringLiteral(right)) {
                    path.replaceWith(t.binaryExpression('+', left.left, t.stringLiteral(left.right.value + right.value)));
                    changed = true;
                }
            }
        }
    });

    return changed;
}

module.exports = {
    decodeStrings
};
