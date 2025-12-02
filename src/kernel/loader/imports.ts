/**
 * Import Utilities
 *
 * Functions for extracting, resolving, and rewriting ES imports.
 */

import { rewriteImportsAST } from './rewriter.js';

/**
 * Extract import paths from JavaScript code.
 *
 * @deprecated Use `Bun.Transpiler.scanImports()` instead.
 * This regex-based approach is fragile and fails on edge cases.
 * Kept for backwards compatibility only.
 *
 * Handles:
 * - import { x } from '/path'
 * - import x from '/path'
 * - import * as x from '/path'
 * - import '/path' (side-effect imports)
 * - export * from '/path' (re-exports)
 * - export { x } from '/path' (named re-exports)
 */
export function extractImports(js: string): string[] {
    const imports: string[] = [];

    // Match various import patterns
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
        while ((match = pattern.exec(js)) !== null) {
            imports.push(match[1]!);
        }
    }

    // Deduplicate
    return [...new Set(imports)];
}

/**
 * Resolve an import path relative to the importing module.
 *
 * @param importPath - The import path as written
 * @param fromModule - The VFS path of the importing module
 * @returns Resolved VFS path
 */
export function resolveImport(importPath: string, fromModule: string): string {
    // Strip .js extension added by transpiler (VFS uses .ts)
    let path = importPath;
    if (path.endsWith('.js')) {
        path = path.slice(0, -3);
    }

    // Handle @rom/ alias -> / (VFS root)
    if (path.startsWith('@rom/')) {
        path = path.slice(4); // '@rom/lib/io' -> '/lib/io'
    }

    // Absolute VFS path
    if (path.startsWith('/')) {
        return path.endsWith('.ts') ? path : path + '.ts';
    }

    // Relative path
    if (path.startsWith('./') || path.startsWith('../')) {
        const fromDir = fromModule.substring(0, fromModule.lastIndexOf('/')) || '/';
        const resolved = resolvePath(fromDir, path);
        return resolved.endsWith('.ts') ? resolved : resolved + '.ts';
    }

    // Built-in or external - return as-is
    return path;
}

/**
 * Simple path resolution (handles . and ..)
 */
export function resolvePath(base: string, relative: string): string {
    const baseParts = base.split('/').filter(Boolean);
    const relativeParts = relative.split('/');

    for (const part of relativeParts) {
        if (part === '.' || part === '') {
            continue;
        } else if (part === '..') {
            baseParts.pop();
        } else {
            baseParts.push(part);
        }
    }

    return '/' + baseParts.join('/');
}

/**
 * Check if a path is a VFS path (vs external/builtin).
 */
export function isVFSPath(path: string): boolean {
    // VFS paths start with / or @rom/
    // External paths include: bun:*, node:*, npm packages
    return path.startsWith('/') || path.startsWith('@rom/');
}

/**
 * Rewrite ES imports to use CommonJS-style __require().
 *
 * Uses AST-based transformation for robust handling of all edge cases.
 *
 * Transforms:
 * - import { x, y } from '/path' -> const { x, y } = __require('/path')
 * - import x from '/path' -> const x = __require('/path').default
 * - import * as x from '/path' -> const x = __require('/path')
 * - import '/path' -> __require('/path')
 * - export { x } -> exports.x = x
 * - export function/class/const x -> (exports added after)
 * - export default x -> exports.default = x
 */
export function rewriteImports(js: string, fromModule: string): string {
    return rewriteImportsAST(js, fromModule);
}
