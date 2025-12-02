/**
 * Import Utilities
 *
 * Functions for extracting, resolving, and rewriting ES imports.
 */

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
    let result = js;

    // import { x, y } from '/path' -> const { x, y } = __require('/path')
    result = result.replace(
        /import\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]/g,
        (_, imports, path) => {
            const resolved = resolveImport(path, fromModule);
            return `const {${imports}} = __require('${resolved}')`;
        }
    );

    // import x from '/path' -> const x = __require('/path').default
    result = result.replace(
        /import\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
        (_, name, path) => {
            const resolved = resolveImport(path, fromModule);
            return `const ${name} = __require('${resolved}').default`;
        }
    );

    // import * as x from '/path' -> const x = __require('/path')
    result = result.replace(
        /import\s+\*\s+as\s+(\w+)\s+from\s+['"]([^'"]+)['"]/g,
        (_, name, path) => {
            const resolved = resolveImport(path, fromModule);
            return `const ${name} = __require('${resolved}')`;
        }
    );

    // import '/path' -> __require('/path')
    result = result.replace(
        /import\s+['"]([^'"]+)['"]\s*;?/g,
        (_, path) => {
            const resolved = resolveImport(path, fromModule);
            return `__require('${resolved}');`;
        }
    );

    // export default x -> exports.default = x
    result = result.replace(
        /export\s+default\s+/g,
        'exports.default = '
    );

    // export * from '/path' -> Object.assign(exports, __require('/path'))
    result = result.replace(
        /export\s+\*\s+from\s+['"]([^'"]+)['"]\s*;?/g,
        (_, path) => {
            const resolved = resolveImport(path, fromModule);
            return `Object.assign(exports, __require('${resolved}'));`;
        }
    );

    // export { x, y } from '/path' -> const __reexport = __require('/path'); exports.x = __reexport.x; ...
    result = result.replace(
        /export\s+\{([^}]+)\}\s+from\s+['"]([^'"]+)['"]\s*;?/g,
        (_, names, path) => {
            const resolved = resolveImport(path, fromModule);
            const items = names.split(',')
                .map((n: string) => n.trim())
                .filter((n: string) => n && !n.startsWith('type '));
            if (items.length === 0) return ''; // Type-only exports
            const tempVar = `__reexport_${Math.random().toString(36).slice(2, 8)}`;
            const assigns = items.map((n: string) => {
                // Handle "x as y" syntax
                const parts = n.split(/\s+as\s+/);
                const source = parts[0]!.trim();
                const exported = (parts[1] ?? parts[0]!).trim();
                return `exports.${exported} = ${tempVar}.${source}`;
            }).join('; ');
            return `const ${tempVar} = __require('${resolved}'); ${assigns};`;
        }
    );

    // export { x, y } -> exports.x = x; exports.y = y
    result = result.replace(
        /export\s+\{([^}]+)\}/g,
        (_, names) => {
            const items = names.split(',').map((n: string) => n.trim()).filter(Boolean);
            return items.map((n: string) => {
                // Handle "x as y" syntax
                const parts = n.split(/\s+as\s+/);
                const local = parts[0]!.trim();
                const exported = (parts[1] ?? parts[0]!).trim();
                return `exports.${exported} = ${local}`;
            }).join('; ');
        }
    );

    // export function x() -> function x() ... (track for later export)
    // export class X -> class X ...
    // export const/let/var x -> const/let/var x ...
    // These need post-processing to add exports

    const exportedNames: string[] = [];

    // Handle async generator functions: export async function* x -> async function* x
    result = result.replace(
        /export\s+(async\s+function\s*\*)\s*(\w+)/g,
        (_, type, name) => {
            exportedNames.push(name);
            return `${type} ${name}`;
        }
    );

    // Handle async functions: export async function x -> async function x
    result = result.replace(
        /export\s+(async\s+function)\s+(\w+)/g,
        (_, type, name) => {
            exportedNames.push(name);
            return `${type} ${name}`;
        }
    );

    // Handle generator functions: export function* x -> function* x
    result = result.replace(
        /export\s+(function\s*\*)\s*(\w+)/g,
        (_, type, name) => {
            exportedNames.push(name);
            return `${type} ${name}`;
        }
    );

    // Handle sync functions and classes: export function x -> function x
    result = result.replace(
        /export\s+(function|class)\s+(\w+)/g,
        (_, type, name) => {
            exportedNames.push(name);
            return `${type} ${name}`;
        }
    );

    result = result.replace(
        /export\s+(const|let|var)\s+(\w+)/g,
        (_, kind, name) => {
            exportedNames.push(name);
            return `${kind} ${name}`;
        }
    );

    // Append exports for named function/class/variable exports
    if (exportedNames.length > 0) {
        const exportStatements = exportedNames.map(name => `exports.${name} = ${name};`).join('\n');
        result += '\n' + exportStatements;
    }

    return result;
}
