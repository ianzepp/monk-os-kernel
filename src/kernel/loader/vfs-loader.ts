/**
 * VFS Loader
 *
 * Compiles and bundles TypeScript scripts from VFS for Worker execution.
 */

import type { VFS } from '@src/vfs/index.js';
import type { HAL } from '@src/hal/index.js';
import type { CachedModule, ModuleCacheConfig } from './types.js';
import { ModuleCache } from './cache.js';
import { resolveImport, isVFSPath, rewriteImports } from './imports.js';

/**
 * VFS Loader for compiling and bundling scripts
 */
export class VFSLoader {
    private vfs: VFS;
    private cache: ModuleCache;
    private transpiler: InstanceType<typeof Bun.Transpiler>;
    private aliases: Map<string, string> = new Map();

    constructor(vfs: VFS, _hal: HAL, cacheConfig?: ModuleCacheConfig) {
        this.vfs = vfs;
        this.cache = new ModuleCache(cacheConfig);
        this.transpiler = new Bun.Transpiler({ loader: 'ts' });
    }

    /**
     * Set import aliases for transpiled-host mounts.
     *
     * Aliases map external package names to VFS paths:
     *   '@monk/process' -> '/lib/process'
     *
     * @param aliases - Map of alias -> VFS path
     */
    setAliases(aliases: Record<string, string>): void {
        for (const [alias, target] of Object.entries(aliases)) {
            this.aliases.set(alias, target);
        }
    }

    /**
     * Get all registered aliases.
     */
    getAliases(): Map<string, string> {
        return new Map(this.aliases);
    }

    /**
     * Resolve an import path, applying aliases if applicable.
     */
    // @ts-expect-error Scaffolding for alias resolution
    private resolveAlias(importPath: string): string {
        // Check for exact alias match
        if (this.aliases.has(importPath)) {
            return this.aliases.get(importPath)!;
        }

        // Check for prefix match (e.g., '@monk/process/foo' -> '/lib/process/foo')
        for (const [alias, target] of this.aliases) {
            if (importPath.startsWith(alias + '/')) {
                return target + importPath.slice(alias.length);
            }
        }

        return importPath;
    }

    /**
     * Compile a module from VFS.
     *
     * Returns cached version if source hash matches.
     */
    async compileModule(vfsPath: string): Promise<CachedModule> {
        // Read source from VFS
        const source = await this.readVFSFile(vfsPath);
        const hash = this.computeHash(source);

        // Check cache
        const cached = this.cache.get(vfsPath);
        if (cached && cached.hash === hash) {
            return cached;
        }

        // Scan imports from TypeScript source (before transpilation)
        // Uses Bun's parser - more robust than regex extraction
        const scanned = this.transpiler.scanImports(source);
        const rawImports = scanned.map(i => i.path);

        // Transpile TypeScript -> JavaScript
        const js = this.transpiler.transformSync(source);

        // Filter to VFS imports only
        const vfsImports = rawImports
            .map(imp => resolveImport(imp, vfsPath))
            .filter(isVFSPath);

        // Rewrite imports
        const rewritten = rewriteImports(js, vfsPath);

        const mod: CachedModule = {
            js: rewritten,
            imports: vfsImports,
            hash,
            usedAt: Date.now(),
        };

        this.cache.set(vfsPath, mod);
        return mod;
    }

    /**
     * Resolve all dependencies for an entry point.
     *
     * Walks the import graph and compiles all modules.
     */
    async resolveDependencies(entryPath: string): Promise<Map<string, CachedModule>> {
        const modules = new Map<string, CachedModule>();
        const queue = [entryPath];
        const visited = new Set<string>();

        while (queue.length > 0) {
            const path = queue.shift()!;

            if (visited.has(path)) {
                continue;
            }
            visited.add(path);

            // Compile module
            const mod = await this.compileModule(path);
            modules.set(path, mod);

            // Queue unresolved VFS dependencies
            for (const imp of mod.imports) {
                if (!visited.has(imp)) {
                    queue.push(imp);
                }
            }
        }

        return modules;
    }

    /**
     * Assemble a bundle from entry point and dependencies.
     *
     * Creates a self-contained JavaScript bundle with:
     * - Module registry
     * - __require() function
     * - All compiled modules
     * - Entry point execution
     */
    async assembleBundle(entryPath: string): Promise<string> {
        const modules = await this.resolveDependencies(entryPath);

        // Module registry preamble
        let bundle = `
'use strict';
const __modules = {};
const __cache = {};

function __require(path) {
    if (__cache[path]) return __cache[path];
    if (!__modules[path]) {
        // Check if it's a built-in
        if (path.startsWith('bun:') || path.startsWith('node:')) {
            throw new Error('Built-in modules not supported in VFS scripts: ' + path);
        }
        throw new Error('Module not found: ' + path);
    }
    const module = { exports: {} };
    const exports = module.exports;
    __modules[path](module, exports, __require);
    __cache[path] = module.exports;
    return module.exports;
}

`;

        // Add each module as a factory function
        for (const [path, mod] of modules) {
            bundle += `
// ${path}
__modules['${path}'] = function(module, exports, __require) {
${mod.js}
};

`;
        }

        // Execute entry point
        bundle += `
// Entry point
__require('${entryPath}');
`;

        return bundle;
    }

    /**
     * Create a Blob URL for a bundle.
     */
    createBlobURL(bundle: string): string {
        const blob = new Blob([bundle], { type: 'application/javascript' });
        return URL.createObjectURL(blob);
    }

    /**
     * Revoke a Blob URL.
     */
    revokeBlobURL(url: string): void {
        URL.revokeObjectURL(url);
    }

    /**
     * Get cache statistics.
     */
    getCacheStats(): { count: number; sizeBytes: number } {
        return this.cache.stats();
    }

    /**
     * Clear the module cache.
     */
    clearCache(): void {
        this.cache.clear();
    }

    /**
     * Invalidate a specific module in cache.
     */
    invalidateModule(path: string): void {
        this.cache.invalidate(path);
    }

    /**
     * Read a file from VFS.
     */
    private async readVFSFile(path: string): Promise<string> {
        const handle = await this.vfs.open(path, { read: true }, 'kernel');
        const chunks: Uint8Array[] = [];

        try {
            while (true) {
                const chunk = await handle.read(65536);
                if (chunk.length === 0) break;
                chunks.push(chunk);
            }
        } finally {
            await handle.close();
        }

        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const combined = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            combined.set(chunk, offset);
            offset += chunk.length;
        }

        return new TextDecoder().decode(combined);
    }

    /**
     * Compute hash of content.
     */
    private computeHash(content: string): string {
        return Bun.hash(content).toString(16);
    }
}
