/**
 * AST-Based Import/Export Rewriter
 *
 * Converts ES modules to CommonJS-style __require() for VFS bundle execution.
 * Uses acorn for robust parsing instead of fragile regex patterns.
 */

import { parse } from 'acorn-loose';
import { resolveImport } from './imports.js';

// Acorn node types we care about
interface AcornNode {
    type: string;
    start: number;
    end: number;
}

interface ImportDeclaration extends AcornNode {
    type: 'ImportDeclaration';
    specifiers: ImportSpecifier[];
    source: { value: string };
}

interface ImportSpecifier extends AcornNode {
    type: 'ImportSpecifier' | 'ImportDefaultSpecifier' | 'ImportNamespaceSpecifier';
    local: { name: string };
    imported?: { name: string };
}

interface ExportNamedDeclaration extends AcornNode {
    type: 'ExportNamedDeclaration';
    declaration: AcornNode | null;
    specifiers: ExportSpecifier[];
    source: { value: string } | null;
}

interface ExportSpecifier extends AcornNode {
    type: 'ExportSpecifier';
    local: { name: string };
    exported: { name: string };
}

interface ExportDefaultDeclaration extends AcornNode {
    type: 'ExportDefaultDeclaration';
    declaration: AcornNode;
}

interface ExportAllDeclaration extends AcornNode {
    type: 'ExportAllDeclaration';
    source: { value: string };
    exported: { name: string } | null;
}

interface Declaration extends AcornNode {
    id?: { name: string };
    declarations?: { id: { name: string } }[];
}

interface Replacement {
    start: number;
    end: number;
    text: string;
}

/**
 * Rewrite ES module imports/exports to CommonJS-style __require().
 *
 * @param js - JavaScript source code (already transpiled from TS)
 * @param fromModule - VFS path of the module being rewritten
 * @returns Rewritten JavaScript with __require() calls
 */
export function rewriteImportsAST(js: string, fromModule: string): string {
    // Use acorn-loose for lenient parsing (doesn't require exports to be defined)
    const ast = parse(js, {
        ecmaVersion: 'latest',
        sourceType: 'module',
    });

    const replacements: Replacement[] = [];
    const exportedNames: string[] = [];

    // Process all top-level statements
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
                    exportedNames
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
    if (exportedNames.length > 0) {
        const exportStatements = exportedNames.map(name => `exports.${name} = ${name};`).join('\n');
        result += '\n' + exportStatements;
    }

    return result;
}

/**
 * Process import declaration.
 *
 * Transforms:
 * - import { x, y } from 'path' -> const { x, y } = __require('path')
 * - import x from 'path' -> const x = __require('path').default
 * - import * as x from 'path' -> const x = __require('path')
 * - import 'path' -> __require('path')
 */
function processImport(
    node: ImportDeclaration,
    fromModule: string,
    replacements: Replacement[]
): void {
    const resolved = resolveImport(node.source.value, fromModule);
    const specifiers = node.specifiers;

    let replacement: string;

    if (specifiers.length === 0) {
        // Side-effect import: import 'path'
        replacement = `__require('${resolved}');`;
    } else {
        const defaultSpec = specifiers.find(s => s.type === 'ImportDefaultSpecifier');
        const namespaceSpec = specifiers.find(s => s.type === 'ImportNamespaceSpecifier');
        const namedSpecs = specifiers.filter(s => s.type === 'ImportSpecifier');

        if (namespaceSpec) {
            // import * as x from 'path'
            replacement = `const ${namespaceSpec.local.name} = __require('${resolved}')`;
        } else if (defaultSpec && namedSpecs.length > 0) {
            // Mixed: import x, { y, z } from 'path'
            const tempVar = `__import_${Math.random().toString(36).slice(2, 8)}`;
            const namedDestructure = namedSpecs
                .map(s => {
                    const imported = (s as ImportSpecifier).imported?.name ?? s.local.name;
                    return imported === s.local.name ? imported : `${imported}: ${s.local.name}`;
                })
                .join(', ');
            replacement = `const ${tempVar} = __require('${resolved}'); const ${defaultSpec.local.name} = ${tempVar}.default; const { ${namedDestructure} } = ${tempVar}`;
        } else if (defaultSpec) {
            // import x from 'path'
            replacement = `const ${defaultSpec.local.name} = __require('${resolved}').default`;
        } else {
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

/**
 * Process named export declaration.
 *
 * Transforms:
 * - export { x, y } -> exports.x = x; exports.y = y
 * - export { x } from 'path' -> const __re = __require('path'); exports.x = __re.x
 * - export function x() {} -> function x() {} (and track for later export)
 * - export const x = 1 -> const x = 1 (and track for later export)
 */
function processExportNamed(
    node: ExportNamedDeclaration,
    fromModule: string,
    replacements: Replacement[],
    exportedNames: string[]
): void {
    if (node.source) {
        // Re-export: export { x } from 'path'
        const resolved = resolveImport(node.source.value, fromModule);

        if (node.specifiers.length === 0) {
            // Should not happen for named exports with source
            return;
        }

        const tempVar = `__reexport_${Math.random().toString(36).slice(2, 8)}`;
        const assigns = node.specifiers
            .map(s => `exports.${s.exported.name} = ${tempVar}.${s.local.name}`)
            .join('; ');
        const replacement = `const ${tempVar} = __require('${resolved}'); ${assigns};`;

        replacements.push({ start: node.start, end: node.end, text: replacement });
    } else if (node.declaration) {
        // export function/class/const/let/var
        const decl = node.declaration as Declaration;

        // Extract the name(s) being exported
        if (decl.id) {
            // function or class declaration
            exportedNames.push(decl.id.name);
        } else if (decl.declarations) {
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
    } else {
        // export { x, y }
        const assigns = node.specifiers
            .map(s => `exports.${s.exported.name} = ${s.local.name}`)
            .join('; ');

        replacements.push({ start: node.start, end: node.end, text: assigns });
    }
}

/**
 * Process default export declaration.
 *
 * Transforms:
 * - export default x -> exports.default = x
 * - export default function() {} -> exports.default = function() {}
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
 * Process export all declaration.
 *
 * Transforms:
 * - export * from 'path' -> Object.assign(exports, __require('path'))
 * - export * as ns from 'path' -> exports.ns = __require('path')
 */
function processExportAll(
    node: ExportAllDeclaration,
    fromModule: string,
    replacements: Replacement[]
): void {
    const resolved = resolveImport(node.source.value, fromModule);

    let replacement: string;
    if (node.exported) {
        // export * as ns from 'path'
        replacement = `exports.${node.exported.name} = __require('${resolved}');`;
    } else {
        // export * from 'path'
        replacement = `Object.assign(exports, __require('${resolved}'));`;
    }

    replacements.push({ start: node.start, end: node.end, text: replacement });
}
