/**
 * AST-Based Import/Export Rewriter
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * The rewriter transforms ES module syntax (import/export) into CommonJS-style
 * __require() calls for execution in VFS-bundled Worker environments. This
 * enables modules loaded from the virtual filesystem to run in isolated Workers
 * where native ES module loading is not available.
 *
 * Instead of fragile regex-based transformation, we use acorn-loose to parse
 * JavaScript into an Abstract Syntax Tree (AST). This provides robust handling
 * of edge cases like multi-line imports, comments within declarations, and
 * string literals that happen to contain "import" or "export" keywords.
 *
 * The transformation is syntax-directed: each AST node type (ImportDeclaration,
 * ExportNamedDeclaration, etc.) has a dedicated handler that generates the
 * appropriate CommonJS replacement. Replacements are collected and applied
 * in reverse order to preserve source offsets during substitution.
 *
 * INVARIANTS (must always hold true)
 * ===================================
 * INV-1: All import statements are converted to __require() calls
 * INV-2: All export statements assign to the exports object
 * INV-3: Import path resolution is delegated to resolveImport()
 * INV-4: Replacements are applied in reverse order (end to start) to maintain offsets
 * INV-5: Original source code outside import/export statements is preserved exactly
 * INV-6: Exported declarations are tracked and assigned to exports after the code
 *
 * CONCURRENCY MODEL
 * =================
 * This module is synchronous and stateless. Each rewriteImportsAST() call
 * operates independently on a single string input. The acorn parser is
 * instantiated per-call, so there is no shared mutable state.
 *
 * Multiple rewrites can run concurrently without interference since there
 * are no instance variables or closures capturing mutable state across calls.
 *
 * MEMORY MANAGEMENT
 * =================
 * - The AST is allocated on each parse() and garbage collected after transformation
 * - Replacement arrays are short-lived and scoped to individual calls
 * - Result string allocation scales linearly with input size
 * - No caching or persistent state - callers should cache if needed (see ModuleCache)
 *
 * @module kernel/loader/rewriter
 */

import { parse } from 'acorn-loose';
import { resolveImport } from './imports.js';

// =============================================================================
// TYPES
// =============================================================================

/**
 * Base acorn AST node.
 *
 * WHY: All AST nodes have these common fields for source location.
 */
interface AcornNode {
    type: string;
    start: number;
    end: number;
}

/**
 * Import declaration AST node.
 *
 * Example: import { x, y } from 'path'
 */
interface ImportDeclaration extends AcornNode {
    type: 'ImportDeclaration';
    specifiers: ImportSpecifier[];
    source: { value: string };
}

/**
 * Import specifier (named, default, or namespace).
 *
 * Examples:
 * - ImportSpecifier: { x } in import { x } from 'path'
 * - ImportDefaultSpecifier: x in import x from 'path'
 * - ImportNamespaceSpecifier: * as x in import * as x from 'path'
 */
interface ImportSpecifier extends AcornNode {
    type: 'ImportSpecifier' | 'ImportDefaultSpecifier' | 'ImportNamespaceSpecifier';
    local: { name: string };
    imported?: { name: string };
}

/**
 * Named export declaration AST node.
 *
 * Examples:
 * - export { x, y }
 * - export { x } from 'path'
 * - export const x = 1
 * - export function x() {}
 */
interface ExportNamedDeclaration extends AcornNode {
    type: 'ExportNamedDeclaration';
    declaration: AcornNode | null;
    specifiers: ExportSpecifier[];
    source: { value: string } | null;
}

/**
 * Export specifier in named exports.
 *
 * Example: x in export { x }
 */
interface ExportSpecifier extends AcornNode {
    type: 'ExportSpecifier';
    local: { name: string };
    exported: { name: string };
}

/**
 * Default export declaration AST node.
 *
 * Examples:
 * - export default x
 * - export default function() {}
 * - export default class X {}
 */
interface ExportDefaultDeclaration extends AcornNode {
    type: 'ExportDefaultDeclaration';
    declaration: AcornNode;
}

/**
 * Export all declaration AST node.
 *
 * Examples:
 * - export * from 'path'
 * - export * as ns from 'path'
 */
interface ExportAllDeclaration extends AcornNode {
    type: 'ExportAllDeclaration';
    source: { value: string };
    exported: { name: string } | null;
}

/**
 * Declaration node (function, class, variable).
 *
 * WHY: Used for extracting names from export declarations.
 */
interface Declaration extends AcornNode {
    id?: { name: string };
    declarations?: { id: { name: string } }[];
}

/**
 * Source code replacement specification.
 *
 * WHY: Collects all transformations before applying them in reverse order
 * to preserve offsets.
 */
interface Replacement {
    /** Start offset in source string */
    start: number;
    /** End offset in source string */
    end: number;
    /** Replacement text */
    text: string;
}

// =============================================================================
// MAIN EXPORT
// =============================================================================

/**
 * Rewrite ES module imports/exports to CommonJS-style __require().
 *
 * ALGORITHM:
 * 1. Parse JavaScript into AST using acorn-loose
 * 2. Walk AST and collect replacements for import/export nodes
 * 3. Sort replacements in reverse order (end to start)
 * 4. Apply replacements to source string
 * 5. Append exports for declaration exports (function, class, const)
 *
 * WHY acorn-loose instead of acorn:
 * Loose parser is permissive and doesn't require exported symbols to be
 * defined, which is common during transpilation. It handles syntax errors
 * gracefully by creating placeholder nodes.
 *
 * WHY reverse order application:
 * When replacing text, later replacements invalidate earlier offsets.
 * Applying from end to start preserves offsets for all pending replacements.
 *
 * @param js - JavaScript source code (already transpiled from TypeScript)
 * @param fromModule - VFS path of the module being rewritten
 * @returns Rewritten JavaScript with __require() calls
 */
export function rewriteImportsAST(js: string, fromModule: string): string {
    // Use acorn-loose for lenient parsing
    // WHY ecmaVersion 'latest': Supports modern ES syntax
    // WHY sourceType 'module': Enables import/export statement parsing
    const ast = parse(js, {
        ecmaVersion: 'latest',
        sourceType: 'module',
    });

    const replacements: Replacement[] = [];
    const exportedNames: string[] = [];

    // Process all top-level statements
    // WHY only top-level: import/export must be at module scope
    for (const node of ast.body) {
        switch (node.type) {
            case 'ImportDeclaration':
                processImport(node as unknown as ImportDeclaration, fromModule, replacements);
                break;

            case 'ExportNamedDeclaration':
                processExportNamed(
                    node as unknown as ExportNamedDeclaration,
                    fromModule,
                    replacements,
                    exportedNames,
                );
                break;

            case 'ExportDefaultDeclaration':
                processExportDefault(node as unknown as ExportDefaultDeclaration, replacements);
                break;

            case 'ExportAllDeclaration':
                processExportAll(node as unknown as ExportAllDeclaration, fromModule, replacements);
                break;
        }
    }

    // Apply replacements from end to start (preserves offsets)
    replacements.sort((a, b) => b.start - a.start);

    let result = js;

    for (const { start, end, text } of replacements) {
        result = result.slice(0, start) + text + result.slice(end);
    }

    // Append exports for declaration exports (function, class, const, etc.)
    // WHY at end instead of inline:
    // Allows declarations to remain in original form for better debugging
    // and ensures the symbol is defined before assignment.
    if (exportedNames.length > 0) {
        const exportStatements = exportedNames.map(name => `exports.${name} = ${name};`).join('\n');

        result += '\n' + exportStatements;
    }

    return result;
}

// =============================================================================
// IMPORT PROCESSING
// =============================================================================

/**
 * Process import declaration and generate CommonJS replacement.
 *
 * TRANSFORMATIONS:
 * - import { x, y } from 'path'        -> const { x, y } = __require('path')
 * - import x from 'path'               -> const x = __require('path').default
 * - import * as x from 'path'          -> const x = __require('path')
 * - import x, { y } from 'path'        -> [mixed default + named, see below]
 * - import 'path'                      -> __require('path')
 *
 * WHY mixed imports use a temp variable:
 * import x, { y } from 'path' becomes:
 *   const __import_abc123 = __require('path');
 *   const x = __import_abc123.default;
 *   const { y } = __import_abc123;
 * This ensures __require() is called exactly once per import statement.
 *
 * @param node - Import declaration AST node
 * @param fromModule - VFS path of importing module
 * @param replacements - Replacement array to append to
 */
function processImport(
    node: ImportDeclaration,
    fromModule: string,
    replacements: Replacement[],
): void {
    // Resolve import path to absolute VFS path or external reference
    const resolved = resolveImport(node.source.value, fromModule);
    const specifiers = node.specifiers;

    let replacement: string;

    if (specifiers.length === 0) {
        // Side-effect import: import 'path'
        // WHY semicolon: Ensures statement termination for safety
        replacement = `__require('${resolved}');`;
    }
    else {
        const defaultSpec = specifiers.find(s => s.type === 'ImportDefaultSpecifier');
        const namespaceSpec = specifiers.find(s => s.type === 'ImportNamespaceSpecifier');
        const namedSpecs = specifiers.filter(s => s.type === 'ImportSpecifier');

        if (namespaceSpec) {
            // import * as x from 'path'
            replacement = `const ${namespaceSpec.local.name} = __require('${resolved}')`;
        }
        else if (defaultSpec && namedSpecs.length > 0) {
            // Mixed: import x, { y, z } from 'path'
            // WHY temp variable: Ensures single __require() call
            const tempVar = `__import_${Math.random().toString(36).slice(2, 8)}`;
            const namedDestructure = namedSpecs
                .map(s => {
                    const imported = (s as ImportSpecifier).imported?.name ?? s.local.name;

                    // WHY check for aliasing: import { x as y } needs 'x: y' syntax
                    return imported === s.local.name ? imported : `${imported}: ${s.local.name}`;
                })
                .join(', ');

            replacement = `const ${tempVar} = __require('${resolved}'); const ${defaultSpec.local.name} = ${tempVar}.default; const { ${namedDestructure} } = ${tempVar}`;
        }
        else if (defaultSpec) {
            // import x from 'path'
            replacement = `const ${defaultSpec.local.name} = __require('${resolved}').default`;
        }
        else {
            // import { x, y } from 'path'
            const destructure = namedSpecs
                .map(s => {
                    const imported = (s as ImportSpecifier).imported?.name ?? s.local.name;

                    return imported === s.local.name ? imported : `${imported}: ${s.local.name}`;
                })
                .join(', ');

            replacement = `const { ${destructure} } = __require('${resolved}')`;
        }
    }

    replacements.push({ start: node.start, end: node.end, text: replacement });
}

// =============================================================================
// EXPORT PROCESSING
// =============================================================================

/**
 * Process named export declaration and generate CommonJS replacement.
 *
 * TRANSFORMATIONS:
 * - export { x, y }                    -> exports.x = x; exports.y = y
 * - export { x } from 'path'           -> const __re_abc = __require('path'); exports.x = __re_abc.x
 * - export function x() {}             -> function x() {} (tracked, assigned at end)
 * - export const x = 1                 -> const x = 1 (tracked, assigned at end)
 *
 * WHY declaration exports are tracked not replaced:
 * Preserves original declaration syntax for debugging. Export assignments
 * are appended at module end after all declarations are complete.
 *
 * WHY re-exports use temp variable:
 * Allows multiple exports from same source to share one __require() call
 * (though current implementation doesn't optimize for this).
 *
 * @param node - Named export declaration AST node
 * @param fromModule - VFS path of exporting module
 * @param replacements - Replacement array to append to
 * @param exportedNames - Array to track declared export names
 */
function processExportNamed(
    node: ExportNamedDeclaration,
    fromModule: string,
    replacements: Replacement[],
    exportedNames: string[],
): void {
    if (node.source) {
        // Re-export: export { x } from 'path'
        const resolved = resolveImport(node.source.value, fromModule);

        if (node.specifiers.length === 0) {
            // Should not happen for named exports with source
            // WHY: Parser should not create this AST structure
            return;
        }

        const tempVar = `__reexport_${Math.random().toString(36).slice(2, 8)}`;
        const assigns = node.specifiers
            .map(s => `exports.${s.exported.name} = ${tempVar}.${s.local.name}`)
            .join('; ');
        const replacement = `const ${tempVar} = __require('${resolved}'); ${assigns};`;

        replacements.push({ start: node.start, end: node.end, text: replacement });
    }
    else if (node.declaration) {
        // export function/class/const/let/var
        const decl = node.declaration as Declaration;

        // Extract the name(s) being exported
        if (decl.id) {
            // function or class declaration
            exportedNames.push(decl.id.name);
        }
        else if (decl.declarations) {
            // variable declaration (const, let, var)
            for (const d of decl.declarations) {
                if (d.id?.name) {
                    exportedNames.push(d.id.name);
                }
            }
        }

        // Remove 'export ' prefix, keep the declaration
        replacements.push({
            start: node.start,
            end: node.declaration.start,
            text: '',
        });
    }
    else {
        // export { x, y }
        const assigns = node.specifiers
            .map(s => `exports.${s.exported.name} = ${s.local.name}`)
            .join('; ');

        replacements.push({ start: node.start, end: node.end, text: assigns });
    }
}

/**
 * Process default export declaration and generate CommonJS replacement.
 *
 * TRANSFORMATIONS:
 * - export default x                   -> exports.default = x
 * - export default function() {}       -> exports.default = function() {}
 * - export default class X {}          -> exports.default = class X {}
 *
 * WHY exports.default instead of module.exports:
 * Maintains consistency with named exports and matches ES module semantics
 * where default is just another export key.
 *
 * @param node - Default export declaration AST node
 * @param replacements - Replacement array to append to
 */
function processExportDefault(node: ExportDefaultDeclaration, replacements: Replacement[]): void {
    // Replace 'export default' with 'exports.default ='
    const declStart = node.declaration.start;

    replacements.push({
        start: node.start,
        end: declStart,
        text: 'exports.default = ',
    });
}

/**
 * Process export all declaration and generate CommonJS replacement.
 *
 * TRANSFORMATIONS:
 * - export * from 'path'               -> Object.assign(exports, __require('path'))
 * - export * as ns from 'path'         -> exports.ns = __require('path')
 *
 * WHY Object.assign for export *:
 * Copies all exported properties from required module to our exports object,
 * matching ES module re-export semantics.
 *
 * @param node - Export all declaration AST node
 * @param fromModule - VFS path of exporting module
 * @param replacements - Replacement array to append to
 */
function processExportAll(
    node: ExportAllDeclaration,
    fromModule: string,
    replacements: Replacement[],
): void {
    const resolved = resolveImport(node.source.value, fromModule);

    let replacement: string;

    if (node.exported) {
        // export * as ns from 'path'
        replacement = `exports.${node.exported.name} = __require('${resolved}');`;
    }
    else {
        // export * from 'path'
        replacement = `Object.assign(exports, __require('${resolved}'));`;
    }

    replacements.push({ start: node.start, end: node.end, text: replacement });
}
