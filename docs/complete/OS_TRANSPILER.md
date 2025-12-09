# VFS Transpiler Architecture

> **Status:** Implemented. Used for core OS services only. Most userspace code execution now happens outside the OS (via gatewayd), reducing the need for further transpiler improvements.

The VFS Loader enables execution of TypeScript stored in the virtual filesystem. This document addresses the fragile regex-based implementation and explores robust alternatives.

---

## Current State

**File:** `src/kernel/loader.ts`

### What Works

- `Bun.Transpiler` for TS→JS conversion (line 443)
- `Bun.hash()` for cache invalidation (line 685)
- LRU module cache with size/count limits
- Dependency graph resolution
- Bundle assembly with `__require()` runtime

### What's Fragile

**Import Extraction (lines 175-203):** 6 regex patterns for parsing imports:

```typescript
const patterns = [
    /import\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+\w+\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+\*\s+as\s+\w+\s+from\s+['"]([^'"]+)['"]/g,
    /import\s+['"]([^'"]+)['"]/g,
    /export\s+\*\s+from\s+['"]([^'"]+)['"]/g,
    /export\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g,
];
```

Fails on:
- Comments containing import-like text
- Multi-line imports
- Template literal paths
- Escaped quotes in paths
- Dynamic imports `import()`

**Import Rewriting (lines 281-429):** ~150 lines of regex transforms:

```typescript
// 12+ replacement patterns for:
// - Named imports: import { x } from 'y'
// - Default imports: import x from 'y'
// - Namespace imports: import * as x from 'y'
// - Side-effect imports: import 'y'
// - Re-exports: export * from 'y', export { x } from 'y'
// - Named exports: export { x }
// - Declaration exports: export function/class/const x
// - Default exports: export default x
// - Async generators: export async function* x
```

Fails on:
- Mixed import styles on one line
- Exports with complex destructuring
- `export type` (partially handled)
- Edge cases in `as` aliasing

---

## Bun.Transpiler Capabilities

### Available Methods

```typescript
const transpiler = new Bun.Transpiler({
    loader: 'ts' | 'tsx' | 'js' | 'jsx',
    target: 'bun' | 'browser',
    tsconfig: { ... },
    macro: boolean,
    deadCodeElimination: boolean,
    inline: boolean,
});

// Sync transformation
const js: string = transpiler.transformSync(code: string, loader?: string);

// Import scanning (returns structured data)
const imports: Import[] = transpiler.scanImports(code: string);
// Import = { path: string, kind: ImportKind }
// ImportKind = 'import-statement' | 'dynamic-import' | 'require-call' | ...

// Full scan with exports
const result = transpiler.scan(code: string);
// result.imports: Import[]
// result.exports: Export[]
```

### What Bun Does NOT Provide

- CommonJS output format (always outputs ES modules)
- Import path rewriting hooks
- Custom module resolution
- AST access for manipulation

---

## Design Options

### Option A: Enhanced Regex (Current Approach)

Keep regex but improve robustness:

1. Use `transpiler.scanImports()` for extraction (replaces 6 patterns)
2. Keep regex rewriting but add preprocessing:
   - Strip comments before matching
   - Normalize whitespace
   - Handle multi-line imports

**Pros:** Minimal change, incremental improvement
**Cons:** Still fragile, regex rewriting remains problematic

### Option B: Two-Pass Transpilation

1. First pass: `Bun.Transpiler` for TS→JS
2. Second pass: `Bun.Transpiler` with custom loader for import rewriting

```typescript
// Hypothetical - requires investigation
const transpiler = new Bun.Transpiler({
    loader: 'js',
    // Can we hook into the import resolution?
});
```

**Pros:** Uses Bun's parser
**Cons:** May not be possible - needs investigation

### Option C: AST-Based Transformation

Use a proper JS parser for rewriting:

```typescript
// Using acorn (small, fast, ES-compliant)
import * as acorn from 'acorn';
import * as walk from 'acorn-walk';

const ast = acorn.parse(js, { sourceType: 'module', ecmaVersion: 'latest' });
walk.simple(ast, {
    ImportDeclaration(node) { /* rewrite */ },
    ExportNamedDeclaration(node) { /* rewrite */ },
    ExportDefaultDeclaration(node) { /* rewrite */ },
    ExportAllDeclaration(node) { /* rewrite */ },
});
```

**Pros:** Correct by construction, handles all edge cases
**Cons:** Adds dependency, more complex, slower

### Option D: Native ES Modules in Workers

Bun Workers support ES modules natively:

```typescript
const worker = new Worker(new URL('./script.ts', import.meta.url));
```

If we could make VFS paths resolvable as URLs, Workers could load them directly.

**Approach:**
1. Register a custom protocol handler or use Blob URLs
2. Generate ES module Blob URLs for each VFS module
3. Let Bun's native loader handle imports

```typescript
// Each module becomes a Blob URL
const moduleUrl = URL.createObjectURL(
    new Blob([js], { type: 'application/javascript' })
);

// Rewrite imports to use Blob URLs
// import '/lib/io.ts' -> import 'blob:...'
```

**Pros:** Native ES modules, no __require() runtime, correct semantics
**Cons:** Import rewriting still needed (but simpler - just URL replacement)

### Option E: Bun's Module Resolution Hook (Future)

Bun has discussed custom loaders. If/when available:

```typescript
// Hypothetical future API
Bun.plugin({
    name: 'vfs-loader',
    setup(build) {
        build.onResolve({ filter: /^\// }, args => ({
            path: args.path,
            namespace: 'vfs',
        }));
        build.onLoad({ filter: /.*/, namespace: 'vfs' }, async args => ({
            contents: await vfs.read(args.path),
            loader: 'ts',
        }));
    },
});
```

**Pros:** Perfect solution, native performance
**Cons:** Doesn't exist yet

---

## Recommended Approach

**Phase 1: Immediate Fixes**

1. Replace `extractImports()` with `transpiler.scanImports()`
2. Add comment stripping before regex rewriting
3. Add test cases for known failure modes

**Phase 2: Blob URL Module System**

1. Keep `Bun.Transpiler` for TS→JS
2. Generate Blob URLs for each module
3. Rewrite imports to reference Blob URLs (simpler than CommonJS conversion)
4. Use native ES module loading in Workers

This preserves ES module semantics while solving the VFS→Worker bridge.

**Phase 3: Future**

When Bun adds module resolution hooks, migrate to native loader.

---

## Implementation Plan

### Phase 1 Tasks

- [ ] Replace `extractImports()` with `transpiler.scanImports()`
- [ ] Add `transpiler.scan()` to also capture exports
- [ ] Strip comments before rewriting (use transpiler output, not source)
- [ ] Add test suite for import/export edge cases
- [ ] Document known limitations

### Phase 2 Tasks

- [ ] Prototype Blob URL approach
- [ ] Benchmark vs current __require() approach
- [ ] Handle circular dependencies with Blob URLs
- [ ] Implement cache invalidation for Blob URLs
- [ ] Migration path from __require() to Blob URLs

---

## Test Cases Needed

```typescript
// Multi-line imports
import {
    foo,
    bar,
    baz,
} from '/lib/utils.ts';

// Mixed on one line
import a, { b, c } from '/lib/mixed.ts';

// Comments
// import { fake } from '/not/real.ts';
/* import { also } from '/fake.ts'; */
import { real } from '/actual.ts';

// Dynamic imports
const mod = await import('/lib/dynamic.ts');

// Type-only (should be stripped)
import type { Foo } from '/lib/types.ts';
export type { Bar } from '/lib/types.ts';

// Complex re-exports
export { default as renamed } from '/lib/other.ts';
export { a as b, c as d } from '/lib/aliases.ts';

// Async generators
export async function* stream() { yield 1; }

// Class with decorators (future)
@decorator
export class Service { }
```

---

## References

- [Bun.Transpiler API](https://bun.sh/docs/api/transpiler)
- [Bun Worker](https://bun.sh/docs/api/workers)
- [acorn parser](https://github.com/acornjs/acorn)
- Current implementation: `src/kernel/loader.ts`
