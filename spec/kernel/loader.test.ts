/**
 * VFS Module Loader Tests
 *
 * Tests for VFS-backed script execution.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import {
    ModuleCache,
    extractImports,
    resolveImport,
    rewriteImports,
    VFSLoader,
} from '@src/kernel/loader.js';
import { createOsStack, type OsStack } from '@src/os/stack.js';

describe('ModuleCache', () => {
    test('should cache and retrieve modules', () => {
        const cache = new ModuleCache();

        cache.set('/lib/test.ts', {
            js: 'const x = 1;',
            imports: [],
            hash: 'abc123',
            usedAt: Date.now(),
        });

        const mod = cache.get('/lib/test.ts');

        expect(mod).toBeDefined();
        expect(mod?.js).toBe('const x = 1;');
        expect(mod?.hash).toBe('abc123');
    });

    test('should update usedAt on get', () => {
        const cache = new ModuleCache();
        const oldTime = Date.now() - 10000;

        cache.set('/lib/test.ts', {
            js: 'const x = 1;',
            imports: [],
            hash: 'abc123',
            usedAt: oldTime,
        });

        const mod = cache.get('/lib/test.ts');

        expect(mod?.usedAt).toBeGreaterThan(oldTime);
    });

    test('should invalidate modules', () => {
        const cache = new ModuleCache();

        cache.set('/lib/test.ts', {
            js: 'const x = 1;',
            imports: [],
            hash: 'abc123',
            usedAt: Date.now(),
        });

        cache.invalidate('/lib/test.ts');
        expect(cache.get('/lib/test.ts')).toBeUndefined();
    });

    test('should clear all modules', () => {
        const cache = new ModuleCache();

        cache.set('/lib/a.ts', { js: 'a', imports: [], hash: 'a', usedAt: Date.now() });
        cache.set('/lib/b.ts', { js: 'b', imports: [], hash: 'b', usedAt: Date.now() });

        cache.clear();

        expect(cache.get('/lib/a.ts')).toBeUndefined();
        expect(cache.get('/lib/b.ts')).toBeUndefined();
        expect(cache.stats().count).toBe(0);
    });

    test('should evict LRU when over maxModules', () => {
        const cache = new ModuleCache({ maxModules: 2 });

        cache.set('/lib/a.ts', { js: 'a', imports: [], hash: 'a', usedAt: Date.now() - 3000 });
        cache.set('/lib/b.ts', { js: 'b', imports: [], hash: 'b', usedAt: Date.now() - 2000 });
        cache.set('/lib/c.ts', { js: 'c', imports: [], hash: 'c', usedAt: Date.now() - 1000 });

        // Should have evicted 'a' (oldest)
        expect(cache.get('/lib/a.ts')).toBeUndefined();
        expect(cache.get('/lib/b.ts')).toBeDefined();
        expect(cache.get('/lib/c.ts')).toBeDefined();
    });
});

describe('extractImports', () => {
    test('should extract named imports', () => {
        const js = `import { foo, bar } from '/lib/utils';`;
        const imports = extractImports(js);

        expect(imports).toContain('/lib/utils');
    });

    test('should extract default imports', () => {
        const js = `import Config from '/lib/config';`;
        const imports = extractImports(js);

        expect(imports).toContain('/lib/config');
    });

    test('should extract namespace imports', () => {
        const js = `import * as utils from '/lib/utils';`;
        const imports = extractImports(js);

        expect(imports).toContain('/lib/utils');
    });

    test('should extract side-effect imports', () => {
        const js = `import '/lib/polyfills';`;
        const imports = extractImports(js);

        expect(imports).toContain('/lib/polyfills');
    });

    test('should deduplicate imports', () => {
        const js = `
            import { foo } from '/lib/utils';
            import { bar } from '/lib/utils';
        `;
        const imports = extractImports(js);

        expect(imports.filter(i => i === '/lib/utils').length).toBe(1);
    });

    test('should handle multiple import types', () => {
        const js = `
            import { open, read } from '/lib/process';
            import Config from '/lib/config';
            import * as helpers from '/lib/helpers';
            import '/lib/polyfills';
        `;
        const imports = extractImports(js);

        expect(imports).toContain('/lib/process');
        expect(imports).toContain('/lib/config');
        expect(imports).toContain('/lib/helpers');
        expect(imports).toContain('/lib/polyfills');
    });
});

describe('resolveImport', () => {
    test('should resolve absolute VFS paths', () => {
        expect(resolveImport('/lib/process', '/bin/app.ts')).toBe('/lib/process.ts');
    });

    test('should preserve .ts extension', () => {
        expect(resolveImport('/lib/process.ts', '/bin/app.ts')).toBe('/lib/process.ts');
    });

    test('should resolve relative paths', () => {
        expect(resolveImport('./helper', '/bin/app.ts')).toBe('/bin/helper.ts');
        expect(resolveImport('../lib/utils', '/bin/sub/app.ts')).toBe('/bin/lib/utils.ts');
    });

    test('should pass through built-in paths', () => {
        expect(resolveImport('bun:test', '/bin/app.ts')).toBe('bun:test');
        expect(resolveImport('node:fs', '/bin/app.ts')).toBe('node:fs');
    });
});

describe('rewriteImports', () => {
    test('should rewrite named imports', () => {
        const js = `import { foo, bar } from '/lib/utils';`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`const { foo, bar } = __require('/lib/utils.ts')`);
    });

    test('should rewrite default imports', () => {
        const js = `import Config from '/lib/config';`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`const Config = __require('/lib/config.ts').default`);
    });

    test('should rewrite namespace imports', () => {
        const js = `import * as utils from '/lib/utils';`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`const utils = __require('/lib/utils.ts')`);
    });

    test('should rewrite side-effect imports', () => {
        const js = `import '/lib/polyfills';`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`__require('/lib/polyfills.ts')`);
    });

    test('should rewrite export default', () => {
        const js = `export default function main() {}`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`exports.default = function main() {}`);
    });

    test('should rewrite named exports', () => {
        const js = `export { foo, bar };`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`exports.foo = foo`);
        expect(result).toContain(`exports.bar = bar`);
    });

    test('should rewrite export function', () => {
        const js = `export function hello() { return 'hi'; }`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`function hello() { return 'hi'; }`);
        expect(result).toContain(`exports.hello = hello`);
    });

    test('should rewrite export const', () => {
        const js = `export const VERSION = '1.0';`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`const VERSION = '1.0';`);
        expect(result).toContain(`exports.VERSION = VERSION`);
    });

    // Edge case tests from OS_TRANSPILER.md
    test('should handle multi-line imports', () => {
        const js = `import {
    foo,
    bar,
    baz,
} from '/lib/utils';`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`__require('/lib/utils.ts')`);
        expect(result).toContain('foo');
        expect(result).toContain('bar');
        expect(result).toContain('baz');
    });

    test('should handle mixed default and named imports', () => {
        const js = `import Config, { version, name } from '/lib/config';`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`__require('/lib/config.ts')`);
        expect(result).toContain('.default');
        expect(result).toContain('version');
        expect(result).toContain('name');
    });

    test('should handle export * from path', () => {
        const js = `export * from '/lib/utils';`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`Object.assign(exports, __require('/lib/utils.ts'))`);
    });

    test('should handle re-exports with aliasing', () => {
        const js = `export { foo as bar } from '/lib/utils';`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`__require('/lib/utils.ts')`);
        expect(result).toContain('exports.bar');
        expect(result).toContain('.foo');
    });

    test('should handle local export aliasing', () => {
        const js = `export { localName as exportedName };`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain('exports.exportedName = localName');
    });

    test('should handle import aliasing', () => {
        const js = `import { foo as bar } from '/lib/utils';`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain(`__require('/lib/utils.ts')`);
        expect(result).toContain('foo: bar');
    });

    test('should handle async function exports', () => {
        const js = `export async function fetchData() { return await fetch('/api'); }`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain('async function fetchData()');
        expect(result).toContain('exports.fetchData = fetchData');
    });

    test('should handle generator function exports', () => {
        const js = `export function* generate() { yield 1; yield 2; }`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain('function* generate()');
        expect(result).toContain('exports.generate = generate');
    });

    test('should handle async generator exports', () => {
        const js = `export async function* stream() { yield 1; }`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain('async function* stream()');
        expect(result).toContain('exports.stream = stream');
    });

    test('should handle class exports', () => {
        const js = `export class Service { constructor() {} }`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain('class Service');
        expect(result).toContain('exports.Service = Service');
    });

    test('should handle export default class', () => {
        const js = `export default class MyClass {}`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain('exports.default = class MyClass');
    });

    test('should handle export default expression', () => {
        const js = `export default { foo: 1, bar: 2 };`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain('exports.default = { foo: 1, bar: 2 }');
    });

    test('should preserve code outside imports/exports', () => {
        const js = `import { foo } from '/lib/utils';
const x = 1;
function helper() { return foo + x; }
export { helper };`;
        const result = rewriteImports(js, '/bin/app.ts');

        expect(result).toContain('const x = 1');
        expect(result).toContain('function helper()');
        expect(result).toContain('exports.helper = helper');
    });
});

describe('VFSLoader', () => {
    let stack: OsStack;
    let loader: VFSLoader;

    beforeEach(async () => {
        stack = await createOsStack({ vfs: true });

        // Create /lib directory
        await stack.vfs!.mkdir('/lib', 'kernel');

        loader = new VFSLoader(stack.vfs!, stack.hal);
    });

    afterEach(async () => {
        await stack.shutdown();
    });

    test('should compile a simple module', async () => {
        const vfs = stack.vfs!;
        // Write a test module to VFS
        const source = `export const message = 'hello';`;
        const handle = await vfs.open('/lib/test.ts', { write: true, create: true }, 'kernel');

        await handle.write(new TextEncoder().encode(source));
        await handle.close();

        const mod = await loader.compileModule('/lib/test.ts');

        expect(mod.js).toContain('const message');
        expect(mod.js).toContain('exports.message = message');
        expect(mod.imports.length).toBe(0);
    });

    test('should extract VFS imports', async () => {
        const vfs = stack.vfs!;
        const source = `
            import { open, read } from '/lib/process';
            export function readAll() {}
        `;
        const handle = await vfs.open('/lib/io.ts', { write: true, create: true }, 'kernel');

        await handle.write(new TextEncoder().encode(source));
        await handle.close();

        const mod = await loader.compileModule('/lib/io.ts');

        expect(mod.imports).toContain('/lib/process.ts');
    });

    test('should cache modules by hash', async () => {
        const vfs = stack.vfs!;
        const source = `export const x = 1;`;
        const handle = await vfs.open('/lib/cached.ts', { write: true, create: true }, 'kernel');

        await handle.write(new TextEncoder().encode(source));
        await handle.close();

        // First compile
        const mod1 = await loader.compileModule('/lib/cached.ts');
        const hash1 = mod1.hash;

        // Second compile (should use cache)
        const mod2 = await loader.compileModule('/lib/cached.ts');

        expect(mod2.hash).toBe(hash1);
    });

    test('should resolve dependencies', async () => {
        const vfs = stack.vfs!;
        // Create /lib/utils.ts
        const utilsSource = `export function format(x: number) { return x.toString(); }`;
        let h = await vfs.open('/lib/utils.ts', { write: true, create: true }, 'kernel');

        await h.write(new TextEncoder().encode(utilsSource));
        await h.close();

        // Create /bin/app.ts that imports utils
        await vfs.mkdir('/bin', 'kernel');
        const appSource = `
            import { format } from '/lib/utils';
            const result = format(42);
        `;

        h = await vfs.open('/bin/app.ts', { write: true, create: true }, 'kernel');
        await h.write(new TextEncoder().encode(appSource));
        await h.close();

        const modules = await loader.resolveDependencies('/bin/app.ts');

        expect(modules.has('/bin/app.ts')).toBe(true);
        expect(modules.has('/lib/utils.ts')).toBe(true);
    });

    test('should assemble a bundle', async () => {
        const vfs = stack.vfs!;
        // Create /lib/helper.ts
        const helperSource = `export const greeting = 'Hello';`;
        let h = await vfs.open('/lib/helper.ts', { write: true, create: true }, 'kernel');

        await h.write(new TextEncoder().encode(helperSource));
        await h.close();

        // Create /bin/main.ts
        await vfs.mkdir('/bin', 'kernel');
        const mainSource = `
            import { greeting } from '/lib/helper';
            console.log(greeting);
        `;

        h = await vfs.open('/bin/main.ts', { write: true, create: true }, 'kernel');
        await h.write(new TextEncoder().encode(mainSource));
        await h.close();

        const bundle = await loader.assembleBundle('/bin/main.ts');

        // Bundle should contain the module registry
        expect(bundle).toContain('__modules');
        expect(bundle).toContain('__require');
        expect(bundle).toContain('/lib/helper.ts');
        expect(bundle).toContain('/bin/main.ts');
        expect(bundle).toContain(`__require('/bin/main.ts')`);
    });

    test('should create and revoke blob URLs', async () => {
        const vfs = stack.vfs!;
        const source = `export const x = 1;`;
        const h = await vfs.open('/lib/blob-test.ts', { write: true, create: true }, 'kernel');

        await h.write(new TextEncoder().encode(source));
        await h.close();

        const bundle = await loader.assembleBundle('/lib/blob-test.ts');
        const url = loader.createBlobURL(bundle);

        expect(url).toMatch(/^blob:/);

        // Should not throw
        loader.revokeBlobURL(url);
    });
});
