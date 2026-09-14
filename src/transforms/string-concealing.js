const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const generator = require('@babel/generator').default;
const t = require('@babel/types');
const vm = require('vm');
const { numericToAST } = require('../utils/ast-utils');

function decodeStrings(ast) {
    let changed = false;

    // 1. Create a safe VM sandbox
    const fakeConsole = { log: () => {}, warn: () => {}, error: () => {}, info: () => {}, debug: () => {} };
    const ctx = vm.createContext({
        TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : undefined,
        TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : undefined,
        Buffer: typeof Buffer !== 'undefined' ? Buffer : undefined,
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
    ctx.global = ctx;
    ctx.globalThis = ctx;
    ctx.window = ctx;

    const globalLookup = new Map([
        [fakeConsole, t.identifier('console')],
        [String, t.identifier('String')],
        [Array, t.identifier('Array')],
        [Object, t.identifier('Object')],
        [Math, t.identifier('Math')],
        [Uint8Array, t.identifier('Uint8Array')],
        [TextDecoder, t.identifier('TextDecoder')],
        [TextEncoder, t.identifier('TextEncoder')],
        [Buffer, t.identifier('Buffer')]
    ]);

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

    function isRetrieveFunction(node) {
        let body = null;
        if (t.isFunctionDeclaration(node) || t.isFunctionExpression(node) || t.isArrowFunctionExpression(node)) {
            body = node.body;
        }
        if (!body || !t.isBlockStatement(body)) return false;
        if (body.body.length > 6) return false;

        let hasSliceReturn = false;
        for (const s of body.body) {
            if (t.isWhileStatement(s) || t.isForStatement(s) || t.isSwitchStatement(s) || t.isDoWhileStatement(s)) {
                return false;
            }
            if (t.isReturnStatement(s)) {
                const arg = s.argument;
                if (t.isCallExpression(arg)) {
                    traverse(arg, {
                        noScope: true,
                        MemberExpression(mp) {
                            const p = mp.node.property;
                            if (t.isIdentifier(p, { name: 'slice' }) || t.isStringLiteral(p, { value: 'slice' })) {
                                hasSliceReturn = true;
                            }
                        }
                    });
                }
            }
        }
        return hasSliceReturn;
    }

    // 2. Identify top-level boilerplate statements in VM
    // Statements that set up string arrays, decoders, and encoding helpers
    const boilerplateStmts = [];
    for (const stmt of ast.program.body) {
        if (t.isReturnStatement(stmt)) continue;
        if (t.isExpressionStatement(stmt)) {
            const expr = stmt.expression;
            if (t.isAssignmentExpression(expr) && t.isIdentifier(expr.left) && t.isStringLiteral(expr.right)) {
                boilerplateStmts.push(stmt);
            }
            continue;
        }

        if (t.isFunctionDeclaration(stmt) || t.isVariableDeclaration(stmt)) {
            boilerplateStmts.push(stmt);
        }
    }

    const getGlobalFns = [];
    traverse(ast, {
        FunctionDeclaration(path) {
            // Only consider top-level helper functions for getGlobal simplification
            if (!path.parentPath.isProgram()) return;
            let hasGlobals = false;

            path.traverse({
                ArrayExpression(arrPath) {
                    if (arrPath.getFunctionParent() !== path) return;
                    if (arrPath.node.elements.length >= 3) {
                        const code = generator(arrPath.node).code;
                        if (code.includes('globalThis') && code.includes('global') && code.includes('window')) {
                            hasGlobals = true;
                        }
                    }
                }
            });

            if (hasGlobals && path.node.id && path.node.body && path.node.body.body && path.node.body.body.length < 15) {
                getGlobalFns.push(path.node.id.name);
                path.get('body').replaceWith(t.blockStatement([
                    t.returnStatement(t.identifier('globalThis'))
                ]));
            }
        }
    });

    ast.program.body.forEach(s => {
        if (t.isVariableDeclaration(s)) {
            s.declarations.forEach(d => {
                if (t.isIdentifier(d.id) && typeof ctx[d.id.name] === 'undefined') {
                    ctx[d.id.name] = ctx;
                }
            });
        }
    });

    try {
        const setupCode = generator(t.program(boilerplateStmts)).code;
        vm.runInContext(setupCode, ctx, { timeout: 1500 });
        getGlobalFns.forEach(fn => {
            if (typeof ctx[fn] === 'undefined') {
                ctx[fn] = () => ctx;
            }
        });
    } catch (e) {}

    // 3. Register decoders accurately per Scope block
    const bindingToFn = new Map();

    traverse(ast, {
        "Program|BlockStatement"(path) {
            const block = path.node;
            const bodyStmts = block.body || [];
            if (bodyStmts.length === 0) return;

            const fnDecls = bodyStmts.filter(s => t.isFunctionDeclaration(s));
            const retrieveFns = fnDecls.filter(isRetrieveFunction);

            if (retrieveFns.length > 0) {
                const codeToRun = fnDecls.map(f => generator(f).code).join('\n');
                for (const rf of retrieveFns) {
                    const fnName = rf.id.name;
                    const binding = path.scope.getBinding(fnName);
                    if (binding) {
                        try {
                            const iife = `(function() {\n${codeToRun}\nreturn ${fnName};\n})()`;
                            const localFn = vm.runInContext(iife, ctx);
                            if (typeof localFn === 'function') {
                                bindingToFn.set(binding, localFn);
                            }
                        } catch (e) {}
                    }
                }
            }
        }
    });

    // 4. Decode retrieve function calls strictly bound to their scope
    traverse(ast, {
        CallExpression(path) {
            if (!t.isIdentifier(path.node.callee)) return;
            const name = path.node.callee.name;
            const binding = path.scope.getBinding(name);
            if (!binding) return;
            const decoder = bindingToFn.get(binding);
            if (!decoder) return;

            // Evaluate arguments
            const args = [];
            let ok = true;
            for (const arg of path.node.arguments) {
                if (t.isNumericLiteral(arg)) args.push(arg.value);
                else if (t.isStringLiteral(arg)) args.push(arg.value);
                else if (t.isUnaryExpression(arg) && arg.operator === '-' && t.isNumericLiteral(arg.argument)) {
                    args.push(-arg.argument.value);
                } else {
                    ok = false;
                    break;
                }
            }
            if (!ok || args.length === 0) return;

            try {
                ctx.__currDecoder = decoder;
                ctx.__currArgs = args;
                const res = vm.runInContext('__currDecoder(...__currArgs)', ctx, { timeout: 200 });
                const astNode = convertToAST(res);
                if (astNode) {
                    path.replaceWith(astNode);
                    changed = true;
                }
            } catch (e) {}
        }
    });

    // 5. String concatenation folding: "a" + "b" -> "ab"
    traverse(ast, {
        BinaryExpression(path) {
            if (path.node.operator === '+' &&
                t.isStringLiteral(path.node.left) &&
                t.isStringLiteral(path.node.right)) {
                path.replaceWith(t.stringLiteral(path.node.left.value + path.node.right.value));
                changed = true;
            }
        }
    });

    return changed;
}

module.exports = {
    decodeStrings
};
