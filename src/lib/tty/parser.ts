/**
 * Shell Command Parser
 *
 * Parses shell-style commands with arguments, quotes, and redirects.
 * Supports variable expansion ($VAR, ${VAR}, ${VAR:-default}).
 */

import type { ParsedCommand } from './types.js';

/**
 * Expand shell variables in a string
 *
 * Supports:
 * - ~ or ~/ - home directory
 * - $VAR - simple variable
 * - ${VAR} - braced variable
 * - ${VAR:-default} - variable with default value
 */
export function expandVariables(
    input: string,
    env: Record<string, string>
): string {
    // ~ at start of string -> $HOME
    let result = input;
    if (result === '~' || result.startsWith('~/')) {
        result = (env['HOME'] || '/') + result.slice(1);
    }

    // ${VAR:-default} - variable with default
    result = result.replace(/\$\{(\w+):-([^}]*)\}/g, (_, name, def) => {
        return env[name] ?? def;
    });

    // ${VAR} - braced variable
    result = result.replace(/\$\{(\w+)\}/g, (_, name) => {
        return env[name] ?? '';
    });

    // $VAR - simple variable (word characters only)
    result = result.replace(/\$(\w+)/g, (_, name) => {
        return env[name] ?? '';
    });

    return result;
}

/**
 * Tokenize input respecting quotes
 */
function tokenize(input: string): string[] {
    const tokens: string[] = [];
    let current = '';
    let inQuote: string | null = null;
    let escape = false;

    for (const char of input) {
        if (escape) {
            current += char;
            escape = false;
            continue;
        }

        if (char === '\\') {
            escape = true;
            continue;
        }

        if ((char === '"' || char === "'") && !inQuote) {
            inQuote = char;
            continue;
        }

        if (char === inQuote) {
            inQuote = null;
            continue;
        }

        if (char === ' ' && !inQuote) {
            if (current) {
                tokens.push(current);
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (current) {
        tokens.push(current);
    }

    return tokens;
}

/**
 * Find character not inside quotes
 */
function findUnquotedChar(str: string, char: string): number {
    let inQuote: string | null = null;
    let escape = false;

    for (let i = 0; i < str.length; i++) {
        const c = str[i];

        if (escape) {
            escape = false;
            continue;
        }

        if (c === '\\') {
            escape = true;
            continue;
        }

        if ((c === '"' || c === "'") && !inQuote) {
            inQuote = c;
            continue;
        }

        if (c === inQuote) {
            inQuote = null;
            continue;
        }

        if (c === char && !inQuote) {
            return i;
        }
    }

    return -1;
}

/**
 * Find operator (&&, ||) not inside quotes
 * Returns { index, operator } or null
 */
function findUnquotedOperator(str: string): { index: number; operator: '&&' | '||' } | null {
    let inQuote: string | null = null;
    let escape = false;

    for (let i = 0; i < str.length - 1; i++) {
        const c = str[i];
        const next = str[i + 1];

        if (escape) {
            escape = false;
            continue;
        }

        if (c === '\\') {
            escape = true;
            continue;
        }

        if ((c === '"' || c === "'") && !inQuote) {
            inQuote = c;
            continue;
        }

        if (c === inQuote) {
            inQuote = null;
            continue;
        }

        if (!inQuote) {
            if (c === '&' && next === '&') {
                return { index: i, operator: '&&' };
            }
            if (c === '|' && next === '|') {
                return { index: i, operator: '||' };
            }
        }
    }

    return null;
}

/**
 * Parse a command string into structured command object
 */
export function parseCommand(input: string): ParsedCommand | null {
    let trimmed = input.trim();
    if (!trimmed) return null;

    // Skip comments
    if (trimmed.startsWith('#')) return null;

    // Check for background operator at end
    let background = false;
    if (trimmed.endsWith('&') && !trimmed.endsWith('&&')) {
        background = true;
        trimmed = trimmed.slice(0, -1).trim();
        if (!trimmed) return null;
    }

    // Handle && and || operators first (lowest precedence)
    const opResult = findUnquotedOperator(trimmed);
    if (opResult) {
        const left = trimmed.slice(0, opResult.index).trim();
        const right = trimmed.slice(opResult.index + 2).trim();
        const leftCmd = parseCommand(left);
        const rightCmd = parseCommand(right);
        if (leftCmd && rightCmd) {
            if (opResult.operator === '&&') {
                leftCmd.andThen = rightCmd;
            } else {
                leftCmd.orElse = rightCmd;
            }
            // Background applies to the whole chain
            leftCmd.background = background;
        }
        return leftCmd;
    }

    // Handle pipes by splitting and recursing
    const pipeIndex = findUnquotedChar(trimmed, '|');
    if (pipeIndex !== -1) {
        const left = trimmed.slice(0, pipeIndex).trim();
        const right = trimmed.slice(pipeIndex + 1).trim();
        const leftCmd = parseCommand(left);
        const rightCmd = parseCommand(right);
        if (leftCmd && rightCmd) {
            leftCmd.pipe = rightCmd;
            // Background applies to the whole pipeline
            leftCmd.background = background;
        }
        return leftCmd;
    }

    const tokens = tokenize(trimmed);
    if (tokens.length === 0) return null;

    const result: ParsedCommand = {
        command: tokens[0],
        args: [],
        background,
    };

    let i = 1;
    while (i < tokens.length) {
        const token = tokens[i];

        if (token === '<' && tokens[i + 1]) {
            result.inputRedirect = tokens[++i];
        } else if (token === '>' && tokens[i + 1]) {
            result.outputRedirect = tokens[++i];
        } else if (token === '>>' && tokens[i + 1]) {
            result.appendRedirect = tokens[++i];
        } else if (token.startsWith('<')) {
            result.inputRedirect = token.slice(1);
        } else if (token.startsWith('>>')) {
            result.appendRedirect = token.slice(2);
        } else if (token.startsWith('>')) {
            result.outputRedirect = token.slice(1);
        } else {
            result.args.push(token);
        }
        i++;
    }

    return result;
}

/**
 * Normalize path (handle . and ..)
 */
function normalizePath(path: string): string {
    const parts = path.split('/').filter(p => p && p !== '.');
    const result: string[] = [];

    for (const part of parts) {
        if (part === '..') {
            result.pop();
        } else {
            result.push(part);
        }
    }

    return '/' + result.join('/');
}

/**
 * Resolve path relative to current working directory
 *
 * @param cwd - Current working directory
 * @param path - Path to resolve (absolute or relative)
 * @returns Absolute normalized path
 */
export function resolvePath(cwd: string, path: string): string {
    // Handle home directory
    if (path.startsWith('~')) {
        path = '/' + path.slice(1);
    }

    // Absolute path
    if (path.startsWith('/')) {
        return normalizePath(path);
    }

    // Relative path
    return normalizePath(cwd + '/' + path);
}
