/**
 * Shell Parser Tests
 *
 * Tests for command parsing, tokenization, and variable expansion.
 * These are pure functions that can be tested in complete isolation.
 */

import { describe, it, expect } from 'bun:test';
import {
    parseCommand,
    tokenize,
    expandVariables,
    expandCommandVariables,
    flattenPipeline,
    findUnquotedChar,
    findUnquotedOperator,
} from '@os/shell/parse.js';

describe('tokenize', () => {
    describe('basic tokenization', () => {
        it('should split on spaces', () => {
            expect(tokenize('ls -la')).toEqual(['ls', '-la']);
        });

        it('should handle multiple spaces', () => {
            expect(tokenize('ls   -la    /tmp')).toEqual(['ls', '-la', '/tmp']);
        });

        it('should handle empty string', () => {
            expect(tokenize('')).toEqual([]);
        });

        it('should handle single token', () => {
            expect(tokenize('ls')).toEqual(['ls']);
        });

        it('should handle leading/trailing spaces', () => {
            expect(tokenize('  ls -la  ')).toEqual(['ls', '-la']);
        });
    });

    describe('single quotes', () => {
        it('should preserve spaces in single quotes', () => {
            expect(tokenize("echo 'hello world'")).toEqual(['echo', 'hello world']);
        });

        it('should handle empty single quotes', () => {
            // Note: empty quotes don't create a token (shell behavior)
            expect(tokenize("echo ''")).toEqual(['echo']);
        });

        it('should handle adjacent single-quoted strings', () => {
            expect(tokenize("echo 'hello''world'")).toEqual(['echo', 'helloworld']);
        });
    });

    describe('double quotes', () => {
        it('should preserve spaces in double quotes', () => {
            expect(tokenize('echo "hello world"')).toEqual(['echo', 'hello world']);
        });

        it('should handle empty double quotes', () => {
            // Note: empty quotes don't create a token (shell behavior)
            expect(tokenize('echo ""')).toEqual(['echo']);
        });

        it('should handle adjacent double-quoted strings', () => {
            expect(tokenize('echo "hello""world"')).toEqual(['echo', 'helloworld']);
        });
    });

    describe('escape sequences', () => {
        it('should escape spaces', () => {
            expect(tokenize('echo hello\\ world')).toEqual(['echo', 'hello world']);
        });

        it('should escape quotes', () => {
            expect(tokenize('echo \\"hello\\"')).toEqual(['echo', '"hello"']);
        });

        it('should escape backslash', () => {
            expect(tokenize('echo \\\\')).toEqual(['echo', '\\']);
        });
    });

    describe('syntax errors', () => {
        it('should return null for unclosed single quote', () => {
            expect(tokenize("echo 'unclosed")).toBeNull();
        });

        it('should return null for unclosed double quote', () => {
            expect(tokenize('echo "unclosed')).toBeNull();
        });

        it('should return null for trailing backslash', () => {
            expect(tokenize('echo test\\')).toBeNull();
        });
    });

    describe('mixed quoting', () => {
        it('should handle single inside double', () => {
            expect(tokenize("echo \"it's\"")).toEqual(['echo', "it's"]);
        });

        it('should handle double inside single', () => {
            expect(tokenize("echo 'say \"hi\"'")).toEqual(['echo', 'say "hi"']);
        });

        it('should handle complex quoting', () => {
            expect(tokenize('cmd "arg with spaces" \'literal\' plain')).toEqual([
                'cmd', 'arg with spaces', 'literal', 'plain',
            ]);
        });
    });
});

describe('expandVariables', () => {
    const env = {
        HOME: '/home/user',
        USER: 'testuser',
        PATH: '/usr/bin',
        EMPTY: '',
    };

    describe('simple variables ($VAR)', () => {
        it('should expand simple variable', () => {
            expect(expandVariables('$HOME', env)).toBe('/home/user');
        });

        it('should expand variable in string', () => {
            expect(expandVariables('$HOME/docs', env)).toBe('/home/user/docs');
        });

        it('should expand multiple variables', () => {
            expect(expandVariables('$USER@$HOME', env)).toBe('testuser@/home/user');
        });

        it('should expand undefined variable to empty string', () => {
            expect(expandVariables('$UNDEFINED', env)).toBe('');
        });

        it('should expand empty variable to empty string', () => {
            expect(expandVariables('$EMPTY', env)).toBe('');
        });
    });

    describe('braced variables (${VAR})', () => {
        it('should expand braced variable', () => {
            expect(expandVariables('${HOME}', env)).toBe('/home/user');
        });

        it('should expand braced variable in string', () => {
            expect(expandVariables('${HOME}/docs', env)).toBe('/home/user/docs');
        });

        it('should expand braced variable adjacent to text', () => {
            expect(expandVariables('${USER}name', env)).toBe('testusername');
        });

        it('should expand undefined braced variable to empty string', () => {
            expect(expandVariables('${UNDEFINED}', env)).toBe('');
        });
    });

    describe('default values (${VAR:-default})', () => {
        it('should use variable value when defined', () => {
            expect(expandVariables('${HOME:-/default}', env)).toBe('/home/user');
        });

        it('should use default when variable undefined', () => {
            expect(expandVariables('${UNDEFINED:-fallback}', env)).toBe('fallback');
        });

        it('should use value even when empty', () => {
            expect(expandVariables('${EMPTY:-fallback}', env)).toBe('');
        });

        it('should handle empty default', () => {
            expect(expandVariables('${UNDEFINED:-}', env)).toBe('');
        });
    });

    describe('tilde expansion', () => {
        it('should expand ~ alone to HOME', () => {
            expect(expandVariables('~', env)).toBe('/home/user');
        });

        it('should expand ~/ to HOME/', () => {
            expect(expandVariables('~/docs', env)).toBe('/home/user/docs');
        });

        it('should not expand ~ in middle of string', () => {
            expect(expandVariables('path/~/file', env)).toBe('path/~/file');
        });

        it('should handle missing HOME', () => {
            expect(expandVariables('~', {})).toBe('/');
        });
    });

    describe('special characters', () => {
        it('should expand $100 as variable name (greedy match)', () => {
            // $100 matches as variable '100' (greedy \w+), not $1 + 00
            // Since '100' is undefined, it becomes empty
            expect(expandVariables('price: $100', env)).toBe('price: ');
        });

        it('should preserve other special chars', () => {
            expect(expandVariables('$HOME/*', env)).toBe('/home/user/*');
        });
    });
});

describe('findUnquotedChar', () => {
    it('should find unquoted character', () => {
        expect(findUnquotedChar('a|b', '|')).toBe(1);
    });

    it('should not find character in single quotes', () => {
        expect(findUnquotedChar("'a|b'", '|')).toBe(-1);
    });

    it('should not find character in double quotes', () => {
        expect(findUnquotedChar('"a|b"', '|')).toBe(-1);
    });

    it('should find character after quotes', () => {
        expect(findUnquotedChar('"a"|b', '|')).toBe(3);
    });

    it('should not find escaped character', () => {
        expect(findUnquotedChar('a\\|b', '|')).toBe(-1);
    });

    it('should return -1 when not found', () => {
        expect(findUnquotedChar('abc', '|')).toBe(-1);
    });
});

describe('findUnquotedOperator', () => {
    it('should find && operator', () => {
        const result = findUnquotedOperator('a && b');

        expect(result).toEqual({ index: 2, operator: '&&' });
    });

    it('should find || operator', () => {
        const result = findUnquotedOperator('a || b');

        expect(result).toEqual({ index: 2, operator: '||' });
    });

    it('should not find operator in quotes', () => {
        expect(findUnquotedOperator('"a && b"')).toBeNull();
        expect(findUnquotedOperator("'a || b'")).toBeNull();
    });

    it('should find first operator', () => {
        const result = findUnquotedOperator('a && b || c');

        expect(result).toEqual({ index: 2, operator: '&&' });
    });

    it('should not confuse single & or |', () => {
        expect(findUnquotedOperator('a & b')).toBeNull();
        expect(findUnquotedOperator('a | b')).toBeNull();
    });

    it('should return null when not found', () => {
        expect(findUnquotedOperator('a b c')).toBeNull();
    });
});

describe('parseCommand', () => {
    describe('simple commands', () => {
        it('should parse simple command', () => {
            const result = parseCommand('ls');

            expect(result).toEqual({
                command: 'ls',
                args: [],
                background: false,
            });
        });

        it('should parse command with arguments', () => {
            const result = parseCommand('ls -la /tmp');

            expect(result).toEqual({
                command: 'ls',
                args: ['-la', '/tmp'],
                background: false,
            });
        });

        it('should parse command with quoted arguments', () => {
            const result = parseCommand('echo "hello world"');

            expect(result).toEqual({
                command: 'echo',
                args: ['hello world'],
                background: false,
            });
        });
    });

    describe('empty/comment handling', () => {
        it('should return null for empty string', () => {
            expect(parseCommand('')).toBeNull();
        });

        it('should return null for whitespace only', () => {
            expect(parseCommand('   ')).toBeNull();
        });

        it('should return null for comment', () => {
            expect(parseCommand('# this is a comment')).toBeNull();
        });
    });

    describe('redirects', () => {
        it('should parse input redirect', () => {
            const result = parseCommand('cat < input.txt');

            expect(result?.inputRedirect).toBe('input.txt');
        });

        it('should parse output redirect', () => {
            const result = parseCommand('ls > output.txt');

            expect(result?.outputRedirect).toBe('output.txt');
        });

        it('should parse append redirect', () => {
            const result = parseCommand('echo hi >> log.txt');

            expect(result?.appendRedirect).toBe('log.txt');
        });

        it('should parse attached redirects', () => {
            const result = parseCommand('cat <input.txt >output.txt');

            expect(result?.inputRedirect).toBe('input.txt');
            expect(result?.outputRedirect).toBe('output.txt');
        });

        it('should parse multiple redirects', () => {
            const result = parseCommand('cmd < in > out');

            expect(result?.inputRedirect).toBe('in');
            expect(result?.outputRedirect).toBe('out');
        });
    });

    describe('pipes', () => {
        it('should parse simple pipe', () => {
            const result = parseCommand('cat file | grep pattern');

            expect(result?.command).toBe('cat');
            expect(result?.args).toEqual(['file']);
            expect(result?.pipe?.command).toBe('grep');
            expect(result?.pipe?.args).toEqual(['pattern']);
        });

        it('should parse multi-stage pipe', () => {
            const result = parseCommand('cat file | grep pattern | wc -l');

            expect(result?.command).toBe('cat');
            expect(result?.pipe?.command).toBe('grep');
            expect(result?.pipe?.pipe?.command).toBe('wc');
            expect(result?.pipe?.pipe?.args).toEqual(['-l']);
        });

        it('should not parse pipe in quotes', () => {
            const result = parseCommand('echo "hello | world"');

            expect(result?.command).toBe('echo');
            expect(result?.args).toEqual(['hello | world']);
            expect(result?.pipe).toBeUndefined();
        });
    });

    describe('chaining (&&, ||)', () => {
        it('should parse && chain', () => {
            const result = parseCommand('mkdir dir && cd dir');

            expect(result?.command).toBe('mkdir');
            expect(result?.args).toEqual(['dir']);
            expect(result?.andThen?.command).toBe('cd');
            expect(result?.andThen?.args).toEqual(['dir']);
        });

        it('should parse || chain', () => {
            const result = parseCommand('test -f file || echo missing');

            expect(result?.command).toBe('test');
            expect(result?.orElse?.command).toBe('echo');
            expect(result?.orElse?.args).toEqual(['missing']);
        });

        it('should parse mixed chain', () => {
            const result = parseCommand('a && b || c');

            expect(result?.command).toBe('a');
            expect(result?.andThen?.command).toBe('b');
            expect(result?.andThen?.orElse?.command).toBe('c');
        });
    });

    describe('background (&)', () => {
        it('should parse background command', () => {
            const result = parseCommand('sleep 10 &');

            expect(result?.command).toBe('sleep');
            expect(result?.args).toEqual(['10']);
            expect(result?.background).toBe(true);
        });

        it('should not confuse && with background', () => {
            const result = parseCommand('a && b');

            expect(result?.background).toBe(false);
        });

        it('should apply background to entire chain', () => {
            const result = parseCommand('a && b &');

            expect(result?.background).toBe(true);
        });
    });
});

describe('expandCommandVariables', () => {
    const env = { HOME: '/home/user', FILE: 'test.txt' };

    it('should expand variables in args', () => {
        const cmd = parseCommand('cat $FILE')!;

        expandCommandVariables(cmd, env);
        expect(cmd.args).toEqual(['test.txt']);
    });

    it('should expand variables in redirects', () => {
        const cmd = parseCommand('cat < $FILE > $HOME/out')!;

        expandCommandVariables(cmd, env);
        expect(cmd.inputRedirect).toBe('test.txt');
        expect(cmd.outputRedirect).toBe('/home/user/out');
    });

    it('should expand variables in pipe chain', () => {
        const cmd = parseCommand('cat $FILE | grep $HOME')!;

        expandCommandVariables(cmd, env);
        expect(cmd.args).toEqual(['test.txt']);
        expect(cmd.pipe?.args).toEqual(['/home/user']);
    });

    it('should expand variables in && chain', () => {
        const cmd = parseCommand('echo $HOME && ls $FILE')!;

        expandCommandVariables(cmd, env);
        expect(cmd.args).toEqual(['/home/user']);
        expect(cmd.andThen?.args).toEqual(['test.txt']);
    });
});

describe('flattenPipeline', () => {
    it('should flatten single command', () => {
        const cmd = parseCommand('ls')!;
        const pipeline = flattenPipeline(cmd);

        expect(pipeline.length).toBe(1);
        expect(pipeline[0]!.command).toBe('ls');
    });

    it('should flatten two-stage pipe', () => {
        const cmd = parseCommand('cat file | grep pattern')!;
        const pipeline = flattenPipeline(cmd);

        expect(pipeline.length).toBe(2);
        expect(pipeline[0]!.command).toBe('cat');
        expect(pipeline[1]!.command).toBe('grep');
    });

    it('should flatten multi-stage pipe', () => {
        const cmd = parseCommand('a | b | c | d')!;
        const pipeline = flattenPipeline(cmd);

        expect(pipeline.length).toBe(4);
        expect(pipeline.map(c => c.command)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('should not include && chain in pipeline', () => {
        const cmd = parseCommand('a | b && c')!;
        const pipeline = flattenPipeline(cmd);

        expect(pipeline.length).toBe(2);
        expect(pipeline.map(c => c.command)).toEqual(['a', 'b']);
    });
});
