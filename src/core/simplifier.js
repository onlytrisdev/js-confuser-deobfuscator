const parser = require('@babel/parser');
const traverse = require('@babel/traverse').default;
const t = require('@babel/types');
const generator = require('@babel/generator').default;
const vm = require('vm');
const {
    numericToAST,
    evaluateCustom,
    hoistVars,
    hasSideEffects,
    getParentFunctionNames
} = require('../utils/ast-utils');

function valueToAST(val, vmGlobals) {
    if (val === null) return t.nullLiteral();
    if (val === undefined) return t.identifier('undefined');
    if (typeof val === 'string') return t.stringLiteral(val);
    if (typeof val === 'number') return numericToAST(val);
    if (typeof val === 'boolean') return t.booleanLiteral(val);
    if (typeof val === 'function') {
        if (val === vmGlobals.vmSymbol) return t.identifier('Symbol');
        if (val === vmGlobals.vmString) return t.identifier('String');
        if (val === vmGlobals.vmArray) return t.identifier('Array');
        if (val === vmGlobals.vmUint8Array) return t.identifier('Uint8Array');
        if (val === vmGlobals.vmTextDecoder) return t.identifier('TextDecoder');
        if (val === vmGlobals.vmBuffer) return t.identifier('Buffer');
        if (val === vmGlobals.vmObject) return t.identifier('Object');
        if (val === vmGlobals.vmFunction) return t.identifier('Function');
        if (val === vmGlobals.vmRegExp) return t.identifier('RegExp');
        if (val === vmGlobals.vmDate) return t.identifier('Date');
        if (val === vmGlobals.vmEval) return t.identifier('eval');
        if (val === vmGlobals.vmObjectKeys) return t.memberExpression(t.identifier('Object'), t.identifier('keys'));
        if (val === vmGlobals.vmObjectDefineProperty) return t.memberExpression(t.identifier('Object'), t.identifier('defineProperty'));
        if (val === vmGlobals.vmObjectGetOwnPropertyDescriptor) return t.memberExpression(t.identifier('Object'), t.identifier('getOwnPropertyDescriptor'));
        if (val === vmGlobals.vmObjectAssign) return t.memberExpression(t.identifier('Object'), t.identifier('assign'));
        if (vmGlobals.vmReflectOwnKeys && val === vmGlobals.vmReflectOwnKeys) return t.memberExpression(t.identifier('Reflect'), t.identifier('ownKeys'));
        if (val === vmGlobals.vmStringFromCharCode) return t.memberExpression(t.identifier('String'), t.identifier('fromCharCode'));
        if (val === vmGlobals.vmStringFromCodePoint) return t.memberExpression(t.identifier('String'), t.identifier('fromCodePoint'));
        if (val === vmGlobals.vmMathFloor) return t.memberExpression(t.identifier('Math'), t.identifier('floor'));
        if (val === vmGlobals.vmMathAbs) return t.memberExpression(t.identifier('Math'), t.identifier('abs'));
        if (val === vmGlobals.vmArrayIsArray) return t.memberExpression(t.identifier('Array'), t.identifier('isArray'));
        if (val === vmGlobals.vmJSONStringify) return t.memberExpression(t.identifier('JSON'), t.identifier('stringify'));
        if (val === vmGlobals.vmJSONParse) return t.memberExpression(t.identifier('JSON'), t.identifier('parse'));
        const funcStr = val.toString();
        if (funcStr.includes('[native code]')) return null;
        try {
            const parsed = parser.parse(`(${funcStr})`, {
                sourceType: 'script',
                allowReturnOutsideFunction: true
            });
            if (parsed.program.body.length === 1 && t.isExpressionStatement(parsed.program.body[0])) {
                return parsed.program.body[0].expression;
            }
        } catch (e) {
            return null;
        }
    }
    if (Array.isArray(val)) {
        const elements = [];
        for (const item of val) {
            const elNode = valueToAST(item, vmGlobals);
            if (!elNode) return null;
            elements.push(elNode);
        }
        return t.arrayExpression(elements);
    }
    if (typeof val === 'object') {
        if (val === vmGlobals.sandbox || val === vmGlobals.globalThis) {
            return t.identifier('globalThis');
        }
        if (val === vmGlobals.sandbox.console) return t.identifier('console');
        if (val === vmGlobals.vmMath) return t.identifier('Math');
        if (val === vmGlobals.sandbox.document) return t.identifier('document');
        if (val === vmGlobals.sandbox.process) return t.identifier('process');
        if (Object.prototype.toString.call(val) === '[object Object]') {
            const properties = [];
            for (const [key, value] of Object.entries(val)) {
                const valNode = valueToAST(value, vmGlobals);
                if (!valNode) return null;
                const keyNode = /^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(key) ? t.identifier(key) : t.stringLiteral(key);
                properties.push(t.objectProperty(keyNode, valNode));
            }
            return t.objectExpression(properties);
        }
    }
    return null;
}

function getClosureCode(pathNode) {
    let currentScope = pathNode.scope;
    let declarationsCode = "";
    const declaredNames = new Set();
    while (currentScope) {
        if (currentScope.block.type === 'Program') break;
        for (const [name, binding] of Object.entries(currentScope.bindings)) {
            if (declaredNames.has(name)) continue;
            let declNode = null;
            if (binding.path.isFunctionDeclaration()) {
                declNode = binding.path.node;
            } else if (binding.path.isVariableDeclarator()) {
                const init = binding.path.node.init;
                if (init && (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init) || t.isLiteral(init))) {
                    declNode = t.variableDeclaration(binding.path.parent.kind || 'var', [t.cloneNode(binding.path.node)]);
                }
            }
            if (!declNode) {
                for (const violatePath of binding.constantViolations) {
                    if (violatePath.isAssignmentExpression() && violatePath.node.operator === '=') {
                        const right = violatePath.node.right;
                        if (t.isFunctionExpression(right) || t.isArrowFunctionExpression(right) || t.isLiteral(right)) {
                            declNode = t.variableDeclaration('var', [t.variableDeclarator(t.identifier(name), t.cloneNode(right))]);
                            break;
                        }
                    }
                }
            }
            if (declNode) {
                try {
                    declarationsCode += generator(declNode).code + "\n";
                    declaredNames.add(name);
                } catch (e) {}
            }
        }
        currentScope = currentScope.parent;
    }
    return declarationsCode;
}

function isStateArrayMutated(funcNode, paramName) {
    let mutated = false;
    traverse(funcNode, {
        noScope: true,
        AssignmentExpression(pathNode) {
            const left = pathNode.node.left;
            if (t.isMemberExpression(left) && t.isIdentifier(left.object) && left.object.name === paramName) {
                mutated = true;
                pathNode.stop();
            }
        },
        UpdateExpression(pathNode) {
            const argument = pathNode.node.argument;
            if (t.isMemberExpression(argument) && t.isIdentifier(argument.object) && argument.object.name === paramName) {
                mutated = true;
                pathNode.stop();
            }
        }
    }, null, null);
    return mutated;
}

function simplifyAST(ast, sandbox, visited, safeGlobals, vmGlobals) {
    console.log("[+] Running multi-pass VM evaluation and simplification...");
    let changed = true;
    let evalPasses = 0;
    let totalDecrypted = 0;
    while (changed && evalPasses < 10) {
        changed = false;
        evalPasses++;
        let passDecrypted = 0;
        traverse(ast, {
            CallExpression(pathNode) {
                const callee = pathNode.node.callee;
                if (t.isIdentifier(callee)) {
                    const name = callee.name;
                    if (visited.has(name)) {
                        const parents = getParentFunctionNames(pathNode);
                        if (parents.some(p => visited.has(p))) return;
                        const hasSide = pathNode.node.arguments.some(hasSideEffects);
                        if (hasSide) return;
                        try {
                            const callCode = generator(pathNode.node).code;
                            const val = vm.runInContext(callCode, sandbox, {
                                timeout: 100
                            });
                            if (val === undefined) return;
                            const astNode = valueToAST(val, vmGlobals);
                            if (astNode) {
                                pathNode.replaceWith(astNode);
                                passDecrypted++;
                                changed = true;
                            }
                        } catch (e) {}
                    }
                }
            },
            MemberExpression(pathNode) {
                if (t.isIdentifier(pathNode.node.object) && visited.has(pathNode.node.object.name)) {
                    const parents = getParentFunctionNames(pathNode);
                    if (parents.some(p => visited.has(p))) return;
                    try {
                        const exprCode = generator(pathNode.node).code;
                        const val = vm.runInContext(exprCode, sandbox, {
                            timeout: 100
                        });
                        if (val === undefined) return;
                        const astNode = valueToAST(val, vmGlobals);
                        if (astNode) {
                            pathNode.replaceWith(astNode);
                            passDecrypted++;
                            changed = true;
                        }
                    } catch (e) {}
                }
            }
        });
        let foldingCount = 0;
        traverse(ast, {
            BinaryExpression(pathNode) {
                const {
                    left,
                    right,
                    operator
                } = pathNode.node;
                if (t.isNumericLiteral(left) && t.isNumericLiteral(right)) {
                    let val;
                    if (operator === '+') val = left.value + right.value;
                    else if (operator === '-') val = left.value - right.value;
                    else if (operator === '*') val = left.value * right.value;
                    else if (operator === '/') val = left.value / right.value;
                    else if (operator === '%') val = left.value % right.value;
                    else return;
                    if (!isFinite(val) || isNaN(val)) return;
                    pathNode.replaceWith(numericToAST(val));
                    foldingCount++;
                    changed = true;
                } else if (operator === '+' && t.isStringLiteral(left) && t.isStringLiteral(right)) {
                    const concatenatedString = left.value + right.value;
                    pathNode.replaceWith(t.stringLiteral(concatenatedString));
                    foldingCount++;
                    changed = true;
                }
            },
            MemberExpression(pathNode) {
                if (pathNode.node.computed && t.isStringLiteral(pathNode.node.property)) {
                    const propName = pathNode.node.property.value;
                    if (/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(propName)) {
                        pathNode.node.computed = false;
                        pathNode.node.property = t.identifier(propName);
                        changed = true;
                    }
                }
            }
        });
        let simpCount = 0;
        traverse(ast, {
            LogicalExpression(pathNode) {
                try {
                    const leftPath = pathNode.get('left');
                    const leftEval = evaluateCustom(leftPath);
                    if (leftEval.confident) {
                        const leftVal = leftEval.value;
                        const operator = pathNode.node.operator;
                        if (operator === '&&') {
                            if (leftVal) {
                                pathNode.replaceWith(pathNode.node.right);
                                simpCount++;
                                changed = true;
                            } else {
                                pathNode.replaceWith(t.booleanLiteral(false));
                                simpCount++;
                                changed = true;
                            }
                        } else if (operator === '||') {
                            if (leftVal) {
                                pathNode.replaceWith(t.booleanLiteral(true));
                                simpCount++;
                                changed = true;
                            } else {
                                pathNode.replaceWith(pathNode.node.right);
                                simpCount++;
                                changed = true;
                            }
                        } else if (operator === '??') {
                            if (leftVal !== null && leftVal !== undefined) {
                                pathNode.replaceWith(leftPath.node);
                                simpCount++;
                                changed = true;
                            } else {
                                pathNode.replaceWith(pathNode.node.right);
                                simpCount++;
                                changed = true;
                            }
                        }
                    }
                } catch (e) {}
            },
            IfStatement(pathNode) {
                try {
                    const testPath = pathNode.get('test');
                    const evaluated = evaluateCustom(testPath);
                    if (evaluated.confident) {
                        const value = !!evaluated.value;
                        if (value) {
                            if (pathNode.node.alternate) {
                                hoistVars(pathNode.get('alternate'));
                            }
                            if (pathNode.node.consequent) {
                                pathNode.replaceWith(pathNode.node.consequent);
                            } else {
                                pathNode.remove();
                            }
                        } else {
                            if (pathNode.node.consequent) {
                                hoistVars(pathNode.get('consequent'));
                            }
                            if (pathNode.node.alternate) {
                                pathNode.replaceWith(pathNode.node.alternate);
                            } else {
                                pathNode.remove();
                            }
                        }
                        simpCount++;
                        changed = true;
                    }
                } catch (e) {}
            },
            ConditionalExpression(pathNode) {
                try {
                    const testPath = pathNode.get('test');
                    const evaluated = evaluateCustom(testPath);
                    if (evaluated.confident) {
                        const value = !!evaluated.value;
                        if (value) {
                            pathNode.replaceWith(pathNode.node.consequent);
                        } else {
                            pathNode.replaceWith(pathNode.node.alternate);
                        }
                        simpCount++;
                        changed = true;
                    }
                } catch (e) {}
            },
            WhileStatement(pathNode) {
                try {
                    const testPath = pathNode.get('test');
                    const evaluated = evaluateCustom(testPath);
                    if (evaluated.confident && !evaluated.value) {
                        hoistVars(pathNode.get('body'));
                        pathNode.remove();
                        simpCount++;
                        changed = true;
                    }
                } catch (e) {}
            },
            ForStatement(pathNode) {
                try {
                    const testPath = pathNode.get('test');
                    if (testPath) {
                        const evaluated = evaluateCustom(testPath);
                        if (evaluated.confident && !evaluated.value) {
                            hoistVars(pathNode.get('body'));
                            if (pathNode.node.init) {
                                pathNode.replaceWith(pathNode.node.init);
                            } else {
                                pathNode.remove();
                            }
                            simpCount++;
                            changed = true;
                        }
                    }
                } catch (e) {}
            },
            DoWhileStatement(pathNode) {
                try {
                    const testPath = pathNode.get('test');
                    const evaluated = evaluateCustom(testPath);
                    if (evaluated.confident && !evaluated.value) {
                        pathNode.replaceWith(pathNode.node.body);
                        simpCount++;
                        changed = true;
                    }
                } catch (e) {}
            },
            SwitchStatement(pathNode) {
                try {
                    const discriminantPath = pathNode.get('discriminant');
                    const evaluated = evaluateCustom(discriminantPath);
                    if (evaluated.confident) {
                        const val = evaluated.value;
                        let matchedCasePath = null;
                        let defaultCasePath = null;
                        const cases = pathNode.get('cases');
                        for (const casePath of cases) {
                            if (!casePath.node.test) {
                                defaultCasePath = casePath;
                            } else {
                                const caseTestVal = evaluateCustom(casePath.get('test'));
                                if (caseTestVal.confident && caseTestVal.value === val) {
                                    matchedCasePath = casePath;
                                    break;
                                }
                            }
                        }
                        const targetCase = matchedCasePath || defaultCasePath;
                        if (targetCase) {
                            const caseStmts = [];
                            const startIndex = cases.indexOf(targetCase);
                            let foundBreak = false;
                            for (let i = startIndex; i < cases.length; i++) {
                                const currCase = cases[i];
                                for (const stmt of currCase.node.consequent) {
                                    if (t.isBreakStatement(stmt)) {
                                        foundBreak = true;
                                        break;
                                    }
                                    caseStmts.push(t.cloneNode(stmt));
                                }
                                if (foundBreak) break;
                            }
                            cases.forEach((caseP, idx) => {
                                if (idx < startIndex || idx > startIndex && foundBreak) {
                                    hoistVars(caseP);
                                }
                            });
                            pathNode.replaceWithMultiple(caseStmts);
                            simpCount++;
                            changed = true;
                        }
                    }
                } catch (e) {}
            }
        });
        let propCount = 0;
        const propsToApply = [];
        traverse(ast, {
            CallExpression(pathNode) {
                const args = pathNode.node.arguments;
                if (args.length === 0) return;
                let funcNode = null;
                const callee = pathNode.node.callee;
                if (t.isIdentifier(callee)) {
                    const binding = pathNode.scope.getBinding(callee.name);
                    if (binding) {
                        if (binding.path.isFunctionDeclaration()) {
                            funcNode = binding.path.node;
                        } else if (binding.path.isVariableDeclarator()) {
                            const init = binding.path.node.init;
                            if (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init)) {
                                funcNode = init;
                            }
                        }
                    }
                }
                if (!funcNode) return;
                for (let i = 0; i < args.length; i++) {
                    const arg = args[i];
                    if (i >= funcNode.params.length) break;
                    const param = funcNode.params[i];
                    if (!t.isIdentifier(param)) continue;
                    if (t.isArrayExpression(arg)) {
                        if (isStateArrayMutated(funcNode, param.name)) {
                            continue;
                        }
                        let stateArray;
                        try {
                            const exprCode = generator(arg).code;
                            stateArray = vm.runInContext(exprCode, sandbox, {
                                timeout: 50
                            });
                            if (!Array.isArray(stateArray)) continue;
                        } catch (e) {
                            continue;
                        }
                        propsToApply.push({
                            funcNode: funcNode,
                            paramName: param.name,
                            paramNode: param,
                            stateArray: stateArray
                        });
                    }
                }
            }
        });
        if (propsToApply.length > 0) {
            traverse(ast, {
                MemberExpression(subPath) {
                    const node = subPath.node;
                    if (t.isIdentifier(node.object)) {
                        const name = node.object.name;
                        for (const prop of propsToApply) {
                            if (prop.paramName === name) {
                                let isInside = false;
                                let parent = subPath.parentPath;
                                while (parent) {
                                    if (parent.node === prop.funcNode) {
                                        isInside = true;
                                        break;
                                    }
                                    parent = parent.parentPath;
                                }
                                if (isInside) {
                                    const binding = subPath.scope.getBinding(name);
                                    if (binding && binding.path.node === prop.paramNode) {
                                        try {
                                            const propCode = generator(node.property).code;
                                            const index = vm.runInContext(propCode, sandbox, {
                                                timeout: 50
                                            });
                                            if (typeof index === 'number' && index >= 0 && index < prop.stateArray.length) {
                                                const val = prop.stateArray[index];
                                                const astNode = valueToAST(val, vmGlobals);
                                                if (astNode) {
                                                    subPath.replaceWith(astNode);
                                                    propCount++;
                                                    changed = true;
                                                }
                                            }
                                        } catch (e) {}
                                    }
                                }
                            }
                        }
                    }
                }
            });
        }
        let inlinePropCount = 0;
        traverse(ast, {
            VariableDeclarator(pathNode) {
                if (t.isIdentifier(pathNode.node.id) && pathNode.node.init) {
                    const init = pathNode.node.init;
                    if (t.isLiteral(init) || t.isIdentifier(init) && init.name === 'undefined') {
                        const name = pathNode.node.id.name;
                        const binding = pathNode.scope.getBinding(name);
                        if (binding && binding.constant) {
                            binding.referencePaths.forEach(refPath => {
                                refPath.replaceWith(t.cloneNode(init));
                                inlinePropCount++;
                                changed = true;
                            });
                            pathNode.remove();
                            changed = true;
                        }
                    }
                }
            }
        });
        console.log(`[+] Eval Pass ${evalPasses}: resolved ${passDecrypted} nodes, folded ${foldingCount} constants, simplified ${simpCount} conditional/dead branches, propagated ${propCount} state array elements, inlined ${inlinePropCount} vars.`);
        totalDecrypted += passDecrypted;
    }
    console.log(`[+] Successfully decrypted/resolved ${totalDecrypted} expressions.`);
    console.log(`[+] Running Constant Propagation...`);
    let cpCount = 0;
    traverse(ast, {
        VariableDeclarator(pathNode) {
            if (t.isIdentifier(pathNode.node.id) && pathNode.node.init) {
                const init = pathNode.node.init;
                if (t.isLiteral(init) || t.isIdentifier(init) && init.name === 'undefined') {
                    const name = pathNode.node.id.name;
                    const binding = pathNode.scope.getBinding(name);
                    if (binding && binding.constant) {
                        binding.referencePaths.forEach(refPath => {
                            refPath.replaceWith(t.cloneNode(init));
                            cpCount++;
                        });
                        pathNode.remove();
                    }
                }
            }
        }
    });
    console.log(`[+] Propagated ${cpCount} constant variables.`);
}
module.exports = {
    valueToAST,
    getClosureCode,
    isStateArrayMutated,
    simplifyAST
};