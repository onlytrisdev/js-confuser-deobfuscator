# Feature Map — `js-confuser-deobfuscator`

| Feature | Summary | Source |
|---|---|---|
| [Deobfuscation Pipeline & AST Polish](deobfuscation-pipeline.md) | Multi-pass AST deobfuscation pipeline unpacking `pack`/`rgf`, decoding strings/globals, unwrapping `dispatcher`/`flatten`/`controlFlowFlattening`/`variableMasking`/`movedDeclarations`, eliminating dead code via scope-aware graph reachability, and polishing AST literals. | `deobfuscator.js`, `src/transforms/*.js`, `src/core/dce.js` |
