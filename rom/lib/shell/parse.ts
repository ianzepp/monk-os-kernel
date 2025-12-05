/**
 * Shell Command Parser
 *
 * Parses shell-style commands with arguments, quotes, and redirects.
 * Supports variable expansion ($VAR, ${VAR}, ${VAR:-default}).
 *
 * Ported from src/lib/tty/parser.ts for use in Monk OS shell.
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
 *
 * @param input - String to expand
 * @param env - Environment variables
 * @returns Expanded string
 *
 * @example
 * expandVariables('$HOME/docs', { HOME: '/home/user' })  // '/home/user/docs'
 * expandVariables('${NAME:-world}', {})                  // 'world'
 */
export function expandVariables(
    input: string,
    env: Record<string, string>,
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
 *
 * Splits input into tokens, handling:
 * - Single quotes (literal, no escape)
 * - Double quotes (allows escapes)
 * - Backslash escapes
 * - Space as delimiter
 *
 * Returns null on syntax errors:
 * - Trailing backslash (incomplete escape)
 * - Unclosed quote
 *
 * @param input - Command line to tokenize
 * @returns Array of tokens, or null on syntax error
 *
 * @example
 * tokenize('echo "hello world"')  // ['echo', 'hello world']
 * tokenize("echo 'it\\'s'")       // ['echo', "it's"]
 * tokenize('echo test\\')         // null (trailing escape)
 * tokenize('echo "unclosed')      // null (unclosed quote)
 */
export function tokenize(input: string): string[] | null {
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

    // Syntax error: trailing backslash (incomplete escape sequence)
    if (escape) {
        return null;
    }

    // Syntax error: unclosed quote
    if (inQuote !== null) {
        return null;
    }

    if (current) {
        tokens.push(current);
    }

    return tokens;
}

/**
 * Find character not inside quotes
 *
 * @param str - String to search
 * @param char - Character to find
 * @returns Index of character, or -1 if not found
 */
export function findUnquotedChar(str: string, char: string): number {
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
 *
 * @param str - String to search
 * @returns Object with index and operator, or null if not found
 */
export function findUnquotedOperator(str: string): { index: number; operator: '&&' | '||' } | null {
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
 *
 * Handles:
 * - Simple commands: `ls -la`
 * - Pipes: `cat file | grep pattern`
 * - Chaining: `cmd1 && cmd2`, `cmd1 || cmd2`
 * - Redirects: `cmd < input > output >> append`
 * - Background: `cmd &`
 * - Comments: `# ignored`
 *
 * @param input - Command line to parse
 * @returns ParsedCommand or null if empty/comment
 *
 * @example
 * parseCommand('ls -la')
 * // { command: 'ls', args: ['-la'], background: false }
 *
 * parseCommand('cat file | grep pattern')
 * // { command: 'cat', args: ['file'], pipe: { command: 'grep', args: ['pattern'], ... }, ... }
 */
export function parseCommand(input: string): ParsedCommand | null {
    let trimmed = input.trim();

    if (!trimmed) {
        return null;
    }

    // Skip comments
    if (trimmed.startsWith('#')) {
        return null;
    }

    // Check for background operator at end
    let background = false;

    if (trimmed.endsWith('&') && !trimmed.endsWith('&&')) {
        background = true;
        trimmed = trimmed.slice(0, -1).trim();
        if (!trimmed) {
            return null;
        }
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
            }
            else {
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

    if (tokens === null || tokens.length === 0) {
        return null;
    }

    const firstToken = tokens[0];

    if (firstToken === undefined) {
        return null;
    }

    const result: ParsedCommand = {
        command: firstToken,
        args: [],
        background,
    };

    let i = 1;

    while (i < tokens.length) {
        const token = tokens[i];

        if (token === undefined) {
            i++;
            continue;
        }

        if (token === '<') {
            const nextToken = tokens[i + 1];

            if (nextToken !== undefined) {
                result.inputRedirect = nextToken;
                i++;
            }
        }
        else if (token === '>') {
            const nextToken = tokens[i + 1];

            if (nextToken !== undefined) {
                result.outputRedirect = nextToken;
                i++;
            }
        }
        else if (token === '>>') {
            const nextToken = tokens[i + 1];

            if (nextToken !== undefined) {
                result.appendRedirect = nextToken;
                i++;
            }
        }
        else if (token.startsWith('<')) {
            result.inputRedirect = token.slice(1);
        }
        else if (token.startsWith('>>')) {
            result.appendRedirect = token.slice(2);
        }
        else if (token.startsWith('>')) {
            result.outputRedirect = token.slice(1);
        }
        else {
            result.args.push(token);
        }

        i++;
    }

    return result;
}

/**
 * Expand variables in a parsed command and its pipeline
 *
 * @param cmd - Parsed command
 * @param env - Environment variables
 */
export function expandCommandVariables(cmd: ParsedCommand, env: Record<string, string>): void {
    cmd.args = cmd.args.map(arg => expandVariables(arg, env));

    if (cmd.inputRedirect) {
        cmd.inputRedirect = expandVariables(cmd.inputRedirect, env);
    }

    if (cmd.outputRedirect) {
        cmd.outputRedirect = expandVariables(cmd.outputRedirect, env);
    }

    if (cmd.appendRedirect) {
        cmd.appendRedirect = expandVariables(cmd.appendRedirect, env);
    }

    if (cmd.pipe) {
        expandCommandVariables(cmd.pipe, env);
    }

    if (cmd.andThen) {
        expandCommandVariables(cmd.andThen, env);
    }

    if (cmd.orElse) {
        expandCommandVariables(cmd.orElse, env);
    }
}

/**
 * Flatten a command pipeline into an array
 *
 * @param cmd - Parsed command (head of pipeline)
 * @returns Array of commands in pipeline order
 */
export function flattenPipeline(cmd: ParsedCommand): ParsedCommand[] {
    const pipeline: ParsedCommand[] = [];
    let current: ParsedCommand | undefined = cmd;

    while (current) {
        pipeline.push(current);
        current = current.pipe;
    }

    return pipeline;
}
