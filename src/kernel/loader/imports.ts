/**
 * Import Utilities - ES module import extraction, resolution, and rewriting
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module provides the core import handling infrastructure for the kernel's
 * module loader. It bridges ES modules (used in TypeScript source) and the
 * kernel's internal require() system which executes in sandboxed workers.
 *
 * The module performs three key functions:
 * 1. **Import Extraction** - Parse JavaScript code to find all import statements
 * 2. **Path Resolution** - Convert relative/aliased paths to absolute VFS paths
 * 3. **Import Rewriting** - Transform ES imports to CommonJS-style __require() calls
 *
 * Import rewriting is necessary because the kernel executes transpiled code in
 * workers that don't have access to Node.js or Bun's native ES module loader.
 * The rewriter converts ES6 import/export syntax to a custom __require() system
 * that the kernel can intercept and fulfill from VFS.
 *
 * Path resolution handles three types of imports:
 * - Absolute VFS paths: /lib/io.ts
 * - Relative imports: ./helper.ts or ../util.ts
 * - Aliased imports: @os/process (maps to /userspace/process)
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All VFS paths are absolute and start with '/'
 * INV-2: VFS TypeScript files use .ts extension, not .js
 * INV-3: @os/ alias always maps to VFS /userspace/
 * INV-4: Path resolution never produces paths with . or .. segments
 * INV-5: External/builtin modules (bun:*, node:*) pass through unchanged
 * INV-6: resolveImport() is idempotent - resolving an already-resolved path returns the same path
 *
 * CONCURRENCY MODEL
 * =================
 * All functions in this module are pure and stateless. They perform synchronous
 * string manipulation and regex matching with no I/O or async operations.
 * This makes them safe to call from any context without coordination.
 *
 * The rewriteImports() function delegates to rewriteImportsAST() which performs
 * AST-based transformation. AST parsing is CPU-bound and synchronous.
 *
 * MEMORY MANAGEMENT
 * =================
 * - extractImports() creates temporary arrays and sets for deduplication
 * - resolvePath() creates temporary arrays for path segment manipulation
 * - rewriteImports() creates new strings - original input is not modified
 * - No long-lived state or caches are maintained in this module
 *
 * @module kernel/loader/imports
 */

import { rewriteImportsAST } from './rewriter.js';

// =============================================================================
// TYPES
// =============================================================================

// None - all functions operate on primitive strings

// =============================================================================
// IMPORT EXTRACTION
// =============================================================================

/**
 * Extract import paths from JavaScript code.
 *
 * @deprecated Use `Bun.Transpiler.scanImports()` instead.
 * This regex-based approach is fragile and fails on edge cases.
 * Kept for backwards compatibility only.
 *
 * WHY this function exists:
 * Before Bun provided scanImports(), we needed a way to discover dependencies
 * for the module cache. This regex-based approach works for simple cases but
 * fails on:
 * - Comments containing import-like syntax
 * - Strings containing import statements
 * - Template literals with dynamic imports
 * - Non-standard formatting
 *
 * WHY it's deprecated but not removed:
 * Some legacy code may still depend on this. New code should use
 * Bun.Transpiler.scanImports() which is AST-based and handles all edge cases.
 *
 * ALGORITHM:
 * 1. Run multiple regex patterns to match import/export statements
 * 2. Extract the path string from each match
 * 3. Deduplicate using Set
 * 4. Return array of unique import paths
 *
 * Handles:
 * - import { x } from '/path'
 * - import x from '/path'
 * - import * as x from '/path'
 * - import '/path' (side-effect imports)
 * - export * from '/path' (re-exports)
 * - export { x } from '/path' (named re-exports)
 *
 * @param js - JavaScript code to scan
 * @returns Array of unique import path strings
 */
export function extractImports(js: string): string[] {
    const imports: string[] = [];

    // WHY multiple patterns instead of one complex regex:
    // Each import syntax has different capture requirements. Combining them
    // would make the regex unreadable and harder to maintain.
    const patterns = [
        // import { x, y } from '/path'
        /import\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g,
        // import x from '/path'
        /import\s+\w+\s+from\s+['"]([^'"]+)['"]/g,
        // import * as x from '/path'
        /import\s+\*\s+as\s+\w+\s+from\s+['"]([^'"]+)['"]/g,
        // import '/path' (side-effect)
        /import\s+['"]([^'"]+)['"]/g,
        // export * from '/path' (re-exports)
        /export\s+\*\s+from\s+['"]([^'"]+)['"]/g,
        // export { x } from '/path' (named re-exports)
        /export\s+\{[^}]*\}\s+from\s+['"]([^'"]+)['"]/g,
    ];

    for (const pattern of patterns) {
        let match;

        // WHY while loop instead of matchAll:
        // Need to reset lastIndex between patterns. exec() provides this control.
        while ((match = pattern.exec(js)) !== null) {
            imports.push(match[1]!);
        }
    }

    // WHY Set for deduplication:
    // A module may import from the same path multiple times (e.g., both
    // type imports and value imports). We only need to know the unique paths.
    return [...new Set(imports)];
}

// =============================================================================
// PATH RESOLUTION
// =============================================================================

/**
 * Resolve an import path relative to the importing module.
 *
 * WHY this function exists:
 * ES modules use relative paths (./foo) and aliases (@os/foo) that must be
 * converted to absolute VFS paths (/userspace/foo.ts) before the kernel can load them.
 *
 * ALGORITHM:
 * 1. Strip .js extension if present (transpiler adds it, VFS uses .ts)
 * 2. Handle @os/ alias by converting to VFS /userspace/
 * 3. If path is absolute, ensure .ts extension and return
 * 4. If path is relative, resolve against fromModule's directory
 * 5. If path is external/builtin, return unchanged
 *
 * Examples:
 * - resolveImport('./helper.js', '/lib/io.ts') -> '/lib/helper.ts'
 * - resolveImport('@os/process', '/app/main.ts') -> '/userspace/process.ts'
 * - resolveImport('../util', '/app/components/button.ts') -> '/app/util.ts'
 * - resolveImport('bun:test', '/test/foo.ts') -> 'bun:test'
 *
 * @param importPath - The import path as written in the source
 * @param fromModule - The absolute VFS path of the importing module
 * @returns Resolved absolute VFS path or external module identifier
 */
export function resolveImport(importPath: string, fromModule: string): string {
    // WHY strip .js extension:
    // TypeScript/Bun transpiler converts 'import "./foo"' to 'import "./foo.js"'
    // for Node.js compatibility, but our VFS stores source as .ts files.
    let path = importPath;

    if (path.endsWith('.js')) {
        path = path.slice(0, -3);
    }

    // WHY @os/ alias:
    // Provides a stable, absolute way to reference userspace modules regardless of
    // the importing module's location. Inspired by TypeScript path mapping.
    if (path.startsWith('@os/')) {
        path = '/userspace' + path.slice(3); // '@os/process' -> '/userspace/process'
    }

    // Absolute VFS path
    if (path.startsWith('/')) {
        // WHY ensure .ts extension:
        // VFS stores TypeScript source. We need the .ts extension for correct lookup.
        return path.endsWith('.ts') ? path : path + '.ts';
    }

    // Relative path
    if (path.startsWith('./') || path.startsWith('../')) {
        // WHY extract directory from fromModule:
        // Relative imports are resolved against the importing file's directory,
        // not the file itself. '/app/main.ts' -> '/app'
        const fromDir = fromModule.substring(0, fromModule.lastIndexOf('/')) || '/';
        const resolved = resolvePath(fromDir, path);

        return resolved.endsWith('.ts') ? resolved : resolved + '.ts';
    }

    // WHY return external modules unchanged:
    // Built-in modules (bun:*, node:*) and npm packages are handled by the
    // runtime's native loader, not by VFS. We don't touch them.
    return path;
}

/**
 * Simple path resolution (handles . and ..)
 *
 * WHY this function exists:
 * Need to normalize relative paths like '/app/lib/../util/helper' to
 * '/app/util/helper' without filesystem access. This is a pure algorithm
 * operating on path strings.
 *
 * ALGORITHM:
 * 1. Split base path into segments
 * 2. Process each relative segment:
 *    - '.' or empty: skip (current directory)
 *    - '..': pop one segment (parent directory)
 *    - other: push segment
 * 3. Join segments with / and prepend root /
 *
 * WHY pop() for '..' instead of checking bounds:
 * If we have too many '..' segments, pop() on empty array is a no-op,
 * which correctly produces '/' (VFS root). This matches POSIX semantics
 * where '/../../foo' normalizes to '/foo'.
 *
 * @param base - Absolute base path (e.g., '/app/lib')
 * @param relative - Relative path (e.g., '../util/helper')
 * @returns Normalized absolute path (e.g., '/app/util/helper')
 */
export function resolvePath(base: string, relative: string): string {
    // WHY filter(Boolean) on baseParts:
    // Handles leading/trailing/double slashes gracefully.
    // '/app//lib/' -> ['app', 'lib']
    const baseParts = base.split('/').filter(Boolean);
    const relativeParts = relative.split('/');

    for (const part of relativeParts) {
        if (part === '.' || part === '') {
            // WHY skip empty and '.':
            // These represent the current directory and don't change the path.
            continue;
        }
        else if (part === '..') {
            // WHY pop():
            // Move up one directory level by removing the last segment.
            baseParts.pop();
        }
        else {
            // WHY push():
            // Normal path segment - append to current path.
            baseParts.push(part);
        }
    }

    // WHY prepend '/' instead of join():
    // VFS paths are always absolute and must start with root.
    // INVARIANT: Maintains INV-1 (all VFS paths start with '/')
    return '/' + baseParts.join('/');
}

// =============================================================================
// PATH CLASSIFICATION
// =============================================================================

/**
 * Check if a path is a VFS path (vs external/builtin).
 *
 * WHY this function exists:
 * The kernel needs to distinguish between VFS modules (loaded from storage)
 * and external modules (loaded from Bun/Node.js runtime). This determines
 * which loader to use.
 *
 * WHY check for @os/ prefix:
 * @os/ is our alias for VFS userspace. Imports using this alias should be
 * resolved from VFS, not treated as npm packages (which also use @ syntax).
 *
 * @param path - Import path to classify
 * @returns true if path should be loaded from VFS, false if external
 */
export function isVFSPath(path: string): boolean {
    // VFS paths start with / or @os/
    // External paths include: bun:*, node:*, npm packages
    return path.startsWith('/') || path.startsWith('@os/');
}

// =============================================================================
// IMPORT REWRITING
// =============================================================================

/**
 * Rewrite ES imports to use CommonJS-style __require().
 *
 * WHY this function exists:
 * The kernel executes module code in workers that don't have access to native
 * ES module loaders. We transpile TypeScript to JavaScript, but ES6 import/export
 * statements remain. This function converts them to __require() calls that the
 * kernel intercepts and fulfills from VFS.
 *
 * WHY delegate to rewriteImportsAST:
 * AST-based transformation is more robust than regex. It handles:
 * - Comments and strings containing "import" keywords
 * - Complex destructuring patterns
 * - Mixed import/export statements
 * - All edge cases in the ES6 module spec
 *
 * Transforms (examples):
 * - import { x, y } from '/path' -> const { x, y } = __require('/path')
 * - import x from '/path' -> const x = __require('/path').default
 * - import * as x from '/path' -> const x = __require('/path')
 * - import '/path' -> __require('/path')
 * - export { x } -> exports.x = x
 * - export function f() {} -> function f() {}; exports.f = f
 * - export default x -> exports.default = x
 *
 * @param js - JavaScript code with ES6 imports/exports
 * @param fromModule - Absolute VFS path of this module (for resolving relative imports)
 * @returns JavaScript code with __require() and exports assignments
 */
export function rewriteImports(js: string, fromModule: string): string {
    // WHY pass fromModule to rewriter:
    // Relative imports need to be resolved to absolute paths in the rewritten
    // code. The rewriter needs to know where this module lives to do that.
    return rewriteImportsAST(js, fromModule);
}
