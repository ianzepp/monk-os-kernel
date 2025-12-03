/**
 * Shell Glob Expansion Tests
 *
 * Tests for filesystem-integrated glob expansion.
 * Uses mock readdir function for isolation.
 */

import { describe, it, expect } from 'bun:test';
import { expandGlobs, expandGlob, type GlobEntry, type ReaddirFn } from '@rom/lib/shell/glob.js';

/**
 * Create a mock readdir function from a directory structure
 */
function createMockReaddir(structure: Record<string, GlobEntry[]>): ReaddirFn {
    return async (path: string): Promise<GlobEntry[]> => {
        const entries = structure[path];
        if (!entries) {
            throw new Error(`ENOENT: ${path}`);
        }
        return entries;
    };
}

/**
 * Helper to create file entries
 */
function file(name: string): GlobEntry {
    return { name, isDirectory: false };
}

/**
 * Helper to create directory entries
 */
function dir(name: string): GlobEntry {
    return { name, isDirectory: true };
}

describe('expandGlobs', () => {
    describe('non-glob arguments', () => {
        it('should pass through non-glob arguments unchanged', async () => {
            const readdir = createMockReaddir({});
            const result = await expandGlobs(['ls', '-la', '/tmp'], '/home', readdir);
            expect(result).toEqual(['ls', '-la', '/tmp']);
        });

        it('should pass through empty array', async () => {
            const readdir = createMockReaddir({});
            const result = await expandGlobs([], '/home', readdir);
            expect(result).toEqual([]);
        });

        it('should not expand escaped glob characters', async () => {
            const readdir = createMockReaddir({
                '/home': [file('test.txt')],
            });
            // Note: backslash escaping is handled by tokenizer, not glob expander
            // So literal * here would be treated as glob
            const result = await expandGlobs(['plain.txt'], '/home', readdir);
            expect(result).toEqual(['plain.txt']);
        });
    });

    describe('star (*) glob', () => {
        const structure = {
            '/home': [
                file('foo.txt'),
                file('bar.txt'),
                file('baz.log'),
                dir('docs'),
            ],
        };

        it('should expand *.txt to matching files', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['*.txt'], '/home', readdir);
            expect(result).toEqual(['bar.txt', 'foo.txt']); // sorted
        });

        it('should expand *.log to matching files', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['*.log'], '/home', readdir);
            expect(result).toEqual(['baz.log']);
        });

        it('should expand * to all entries', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['*'], '/home', readdir);
            expect(result).toEqual(['bar.txt', 'baz.log', 'docs/', 'foo.txt']);
        });

        it('should expand *o* to matching files', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['*o*'], '/home', readdir);
            // 'baz.log' contains 'o' in extension too
            expect(result).toEqual(['baz.log', 'docs/', 'foo.txt']);
        });

        it('should append / to directory matches', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['doc*'], '/home', readdir);
            expect(result).toEqual(['docs/']);
        });
    });

    describe('question mark (?) glob', () => {
        const structure = {
            '/home': [
                file('a.txt'),
                file('ab.txt'),
                file('abc.txt'),
            ],
        };

        it('should expand ?.txt to single character match', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['?.txt'], '/home', readdir);
            expect(result).toEqual(['a.txt']);
        });

        it('should expand ??.txt to two character match', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['??.txt'], '/home', readdir);
            expect(result).toEqual(['ab.txt']);
        });

        it('should expand ???.txt to three character match', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['???.txt'], '/home', readdir);
            expect(result).toEqual(['abc.txt']);
        });
    });

    describe('bracket ([]) glob', () => {
        const structure = {
            '/home': [
                file('a.txt'),
                file('b.txt'),
                file('c.txt'),
                file('1.txt'),
            ],
        };

        it('should expand [ab].txt to character class match', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['[ab].txt'], '/home', readdir);
            expect(result).toEqual(['a.txt', 'b.txt']);
        });

        it('should expand [0-9].txt to range match', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['[0-9].txt'], '/home', readdir);
            expect(result).toEqual(['1.txt']);
        });

        it('should expand [!a].txt to negated match', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['[!a].txt'], '/home', readdir);
            expect(result).toEqual(['1.txt', 'b.txt', 'c.txt']);
        });
    });

    describe('path-based globs', () => {
        const structure = {
            '/': [dir('home'), dir('tmp')],
            '/home': [file('test.txt')],
            '/tmp': [file('temp.txt'), file('temp.log')],
        };

        it('should expand /tmp/*.txt with absolute path', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['/tmp/*.txt'], '/home', readdir);
            expect(result).toEqual(['/tmp/temp.txt']);
        });

        it('should expand ../tmp/*.txt with relative path', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['../tmp/*.txt'], '/home', readdir);
            expect(result).toEqual(['/tmp/temp.txt']);
        });

        it('should keep path prefix for absolute globs', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['/tmp/*'], '/home', readdir);
            expect(result).toEqual(['/tmp/temp.log', '/tmp/temp.txt']);
        });
    });

    describe('no matches', () => {
        const structure = {
            '/home': [file('foo.txt')],
        };

        it('should keep literal when no matches (bash behavior)', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['*.log'], '/home', readdir);
            expect(result).toEqual(['*.log']); // kept as literal
        });
    });

    describe('error handling', () => {
        it('should keep literal on readdir error', async () => {
            const readdir = createMockReaddir({}); // no directories defined
            const result = await expandGlobs(['*.txt'], '/nonexistent', readdir);
            expect(result).toEqual(['*.txt']);
        });
    });

    describe('multiple arguments', () => {
        const structure = {
            '/home': [
                file('a.txt'),
                file('b.txt'),
                file('c.log'),
            ],
        };

        it('should expand multiple glob arguments', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['*.txt', '*.log'], '/home', readdir);
            expect(result).toEqual(['a.txt', 'b.txt', 'c.log']);
        });

        it('should mix expanded and non-glob arguments', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['-la', '*.txt'], '/home', readdir);
            expect(result).toEqual(['-la', 'a.txt', 'b.txt']);
        });
    });

    describe('sorting', () => {
        const structure = {
            '/home': [
                file('zebra.txt'),
                file('apple.txt'),
                file('mango.txt'),
            ],
        };

        it('should sort matches alphabetically', async () => {
            const readdir = createMockReaddir(structure);
            const result = await expandGlobs(['*.txt'], '/home', readdir);
            expect(result).toEqual(['apple.txt', 'mango.txt', 'zebra.txt']);
        });
    });
});

describe('expandGlob', () => {
    it('should expand single argument', async () => {
        const readdir = createMockReaddir({
            '/home': [file('test.txt'), file('test.log')],
        });
        const result = await expandGlob('*.txt', '/home', readdir);
        expect(result).toEqual(['test.txt']);
    });

    it('should return array with single non-glob', async () => {
        const readdir = createMockReaddir({});
        const result = await expandGlob('plain.txt', '/home', readdir);
        expect(result).toEqual(['plain.txt']);
    });
});
