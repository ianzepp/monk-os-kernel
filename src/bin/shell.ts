/**
 * Monk OS Shell
 *
 * Interactive command interpreter for Monk OS.
 *
 * Features:
 * - Command parsing with pipes (|), chaining (&&, ||), and redirects (<, >, >>)
 * - Variable expansion ($VAR, ${VAR}, ${VAR:-default})
 * - Glob expansion (*, ?, [...])
 * - Command history
 * - Built-in commands (cd, export, exit)
 *
 * Usage:
 *   shell              Interactive mode
 *   shell -c "cmd"     Execute single command
 *   shell script.sh    Execute script file
 */

import {
    getargs,
    getenv,
    setenv,
    getcwd,
    chdir,
    stat,
    readdir,
    spawn,
    wait,
    open,
    read,
    write,
    close,
    exit,
    print,
    println,
    eprintln,
    pipe,
} from '@src/process/index.js';

import {
    parseCommand,
    expandVariables,
    expandCommandVariables,
    flattenPipeline,
    expandGlobs,
    resolvePath,
    parseArgs,
    type ParsedCommand,
    type GlobEntry,
} from '@src/lib/shell/index.js';

// ============================================================================
// Constants
// ============================================================================

const SHELL_VERSION = '0.1.0';
const HISTSIZE_DEFAULT = 1000;

// Built-in commands that must run in shell process (not spawned)
const BUILTIN_COMMANDS = ['cd', 'export', 'exit', 'history', 'set', 'unset', 'echo', 'pwd', 'true', 'false'];

// Resolve bin directory from this file's location
const BIN_PATH = new URL('.', import.meta.url).pathname;

// ============================================================================
// Shell State
// ============================================================================

interface ShellState {
    /** Current working directory */
    cwd: string;

    /** Environment variables */
    env: Record<string, string>;

    /** Command history */
    history: string[];

    /** Last exit code */
    lastExitCode: number;

    /** Interactive mode flag */
    interactive: boolean;

    /** Should exit flag */
    shouldExit: boolean;

    /** Exit code to return */
    exitCode: number;
}

async function createShellState(): Promise<ShellState> {
    const cwd = await getcwd();

    // Build env from process environment
    const env: Record<string, string> = {
        HOME: await getenv('HOME') ?? '/',
        USER: await getenv('USER') ?? 'root',
        SHELL: '/bin/shell',
        PWD: cwd,
        OLDPWD: cwd,
        '?': '0',
        HISTSIZE: String(HISTSIZE_DEFAULT),
    };

    return {
        cwd,
        env,
        history: [],
        lastExitCode: 0,
        interactive: true,
        shouldExit: false,
        exitCode: 0,
    };
}

// ============================================================================
// Readline (Simple Implementation)
// ============================================================================

/**
 * Read a line from stdin
 *
 * Simple implementation - reads character by character until newline.
 * TODO: Add line editing, history navigation, tab completion
 */
async function readline(): Promise<string | null> {
    const chunks: Uint8Array[] = [];

    while (true) {
        const chunk = await read(0, 1);
        if (chunk.length === 0) {
            // EOF
            if (chunks.length === 0) return null;
            break;
        }

        const char = chunk[0];

        // Newline - end of line
        if (char === 0x0a || char === 0x0d) {
            break;
        }

        chunks.push(chunk);
    }

    const total = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    return new TextDecoder().decode(result);
}

// ============================================================================
// Prompt
// ============================================================================

async function printPrompt(state: ShellState): Promise<void> {
    const user = state.env['USER'] ?? 'user';
    const host = 'monk';
    const cwd = state.cwd === state.env['HOME'] ? '~' : state.cwd;
    const prompt = `${user}@${host}:${cwd}$ `;
    await print(prompt);
}

// ============================================================================
// Glob Expansion Helper
// ============================================================================

async function readdirForGlob(path: string): Promise<GlobEntry[]> {
    try {
        const names = await readdir(path);
        const entries: GlobEntry[] = [];

        for (const name of names) {
            const fullPath = path === '/' ? `/${name}` : `${path}/${name}`;
            try {
                const info = await stat(fullPath);
                entries.push({
                    name,
                    isDirectory: info.model === 'folder',
                });
            } catch {
                entries.push({ name, isDirectory: false });
            }
        }

        return entries;
    } catch {
        return [];
    }
}

// ============================================================================
// Built-in Commands
// ============================================================================

async function builtinCd(state: ShellState, args: string[]): Promise<number> {
    let target: string;

    if (args.length === 0) {
        target = state.env['HOME'] ?? '/';
    } else if (args[0] === '-') {
        target = state.env['OLDPWD'] ?? state.cwd;
    } else {
        target = resolvePath(state.cwd, args[0]);
    }

    // Verify directory exists
    try {
        const info = await stat(target);
        if (info.model !== 'folder') {
            await eprintln(`cd: ${args[0]}: Not a directory`);
            return 1;
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`cd: ${args[0]}: ${msg}`);
        return 1;
    }

    // Update state
    state.env['OLDPWD'] = state.cwd;
    state.cwd = target;
    state.env['PWD'] = target;

    // Also update kernel process cwd
    await chdir(target);

    return 0;
}

async function builtinExport(state: ShellState, args: string[]): Promise<number> {
    if (args.length === 0) {
        // Print all exports
        for (const [key, value] of Object.entries(state.env)) {
            await println(`export ${key}="${value}"`);
        }
        return 0;
    }

    for (const arg of args) {
        const eqIndex = arg.indexOf('=');
        if (eqIndex === -1) {
            // Just name - mark for export (no-op in our implementation)
            continue;
        }

        const name = arg.slice(0, eqIndex);
        const value = arg.slice(eqIndex + 1);
        state.env[name] = value;
        await setenv(name, value);
    }

    return 0;
}

async function builtinHistory(state: ShellState, _args: string[]): Promise<number> {
    for (let i = 0; i < state.history.length; i++) {
        await println(`${String(i + 1).padStart(5)}  ${state.history[i]}`);
    }
    return 0;
}

async function builtinExit(state: ShellState, args: string[]): Promise<number> {
    const code = args.length > 0 ? parseInt(args[0], 10) : state.lastExitCode;
    state.shouldExit = true;
    state.exitCode = isNaN(code) ? 0 : code;
    return state.exitCode;
}

async function executeBuiltin(
    state: ShellState,
    command: string,
    args: string[]
): Promise<number> {
    switch (command) {
        case 'cd':
            return builtinCd(state, args);
        case 'export':
            return builtinExport(state, args);
        case 'history':
            return builtinHistory(state, args);
        case 'exit':
            return builtinExit(state, args);
        case 'set':
            // TODO: implement set
            return 0;
        case 'unset':
            // TODO: implement unset
            return 0;
        case 'echo':
            await println(args.join(' '));
            return 0;
        case 'pwd':
            await println(state.cwd);
            return 0;
        case 'true':
            return 0;
        case 'false':
            return 1;
        default:
            return 127;
    }
}

// ============================================================================
// External Command Execution
// ============================================================================

/**
 * Find command in PATH or as absolute/relative path
 */
async function findCommand(command: string, cwd: string): Promise<string | null> {
    // Absolute or relative path
    if (command.startsWith('/') || command.startsWith('./') || command.startsWith('../')) {
        const path = command.startsWith('/') ? command : resolvePath(cwd, command);
        try {
            await stat(path);
            return path;
        } catch {
            return null;
        }
    }

    // Search in BIN_PATH
    const binPath = `${BIN_PATH}/${command}.ts`;
    try {
        await stat(binPath);
        return binPath;
    } catch {
        return null;
    }
}

/**
 * Execute an external command
 *
 * @param state - Shell state
 * @param command - Command name
 * @param args - Command arguments
 * @param stdin - Optional stdin fd override
 * @param stdout - Optional stdout fd override
 * @returns Exit code
 */
async function executeExternal(
    state: ShellState,
    command: string,
    args: string[],
    stdin?: number,
    stdout?: number
): Promise<number> {
    const cmdPath = await findCommand(command, state.cwd);

    if (!cmdPath) {
        await eprintln(`${command}: command not found`);
        return 127;
    }

    try {
        const pid = await spawn(cmdPath, {
            args: [command, ...args],
            cwd: state.cwd,
            env: state.env,
            stdin,
            stdout,
        });

        const status = await wait(pid);
        return status.code;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`${command}: ${msg}`);
        return 126;
    }
}

// ============================================================================
// Command Execution
// ============================================================================

/**
 * Execute a single command (no pipes)
 *
 * @param state - Shell state
 * @param cmd - Parsed command
 * @param stdin - Optional stdin fd override
 * @param stdout - Optional stdout fd override
 * @returns Exit code
 */
async function executeSingleCommand(
    state: ShellState,
    cmd: ParsedCommand,
    stdin?: number,
    stdout?: number
): Promise<number> {
    // Expand globs in arguments
    const expandedArgs = await expandGlobs(cmd.args, state.cwd, readdirForGlob);

    // Check for built-in
    if (BUILTIN_COMMANDS.includes(cmd.command)) {
        // Builtins run in shell process, so we can't redirect their I/O
        // through kernel fds. For now, just run them normally.
        // TODO: Support redirecting builtin I/O
        return executeBuiltin(state, cmd.command, expandedArgs);
    }

    // External command
    return executeExternal(state, cmd.command, expandedArgs, stdin, stdout);
}

/**
 * Execute a pipeline of commands
 *
 * Creates pipes between commands and runs them concurrently.
 * Returns the exit code of the last command in the pipeline.
 */
async function executePipeline(
    state: ShellState,
    pipeline: ParsedCommand[]
): Promise<number> {
    if (pipeline.length === 0) return 0;

    // Single command - no pipes needed
    if (pipeline.length === 1) {
        return executeSingleCommand(state, pipeline[0]);
    }

    // Multi-command pipeline
    // Create pipes between each pair of commands
    const pipes: Array<[number, number]> = [];
    const fdsToClose: number[] = [];

    try {
        // Create N-1 pipes for N commands
        for (let i = 0; i < pipeline.length - 1; i++) {
            const [readFd, writeFd] = await pipe();
            pipes.push([readFd, writeFd]);
            fdsToClose.push(readFd, writeFd);
        }

        // Start all commands concurrently
        const commandPromises: Promise<number>[] = [];

        for (let i = 0; i < pipeline.length; i++) {
            const cmd = pipeline[i];
            const isFirst = i === 0;
            const isLast = i === pipeline.length - 1;

            // Determine stdin/stdout for this command
            const stdin = isFirst ? undefined : pipes[i - 1][0];  // Read from previous pipe
            const stdout = isLast ? undefined : pipes[i][1];      // Write to next pipe

            // Start command (don't await yet - run concurrently)
            commandPromises.push(executeSingleCommand(state, cmd, stdin, stdout));
        }

        // Close our copies of the pipe ends
        // The child processes have their own references
        for (const fd of fdsToClose) {
            await close(fd).catch(() => {});
        }
        fdsToClose.length = 0;

        // Wait for all commands to complete
        const results = await Promise.all(commandPromises);

        // Return exit code of last command
        return results[results.length - 1];
    } finally {
        // Clean up any remaining fds on error
        for (const fd of fdsToClose) {
            await close(fd).catch(() => {});
        }
    }
}

/**
 * Execute a command chain (handles &&, ||)
 */
async function executeChain(
    state: ShellState,
    cmd: ParsedCommand
): Promise<number> {
    // Expand variables
    expandCommandVariables(cmd, state.env);

    // Flatten pipeline
    const pipeline = flattenPipeline(cmd);

    // Execute pipeline
    const exitCode = await executePipeline(state, pipeline);

    // Update $?
    state.env['?'] = String(exitCode);
    state.lastExitCode = exitCode;

    // Handle && chain (run next if this succeeded)
    if (cmd.andThen && exitCode === 0) {
        return executeChain(state, cmd.andThen);
    }

    // Handle || chain (run next if this failed)
    if (cmd.orElse && exitCode !== 0) {
        return executeChain(state, cmd.orElse);
    }

    return exitCode;
}

/**
 * Execute a command line
 */
async function executeLine(state: ShellState, line: string): Promise<number> {
    const trimmed = line.trim();

    // Empty line or comment
    if (!trimmed || trimmed.startsWith('#')) {
        return 0;
    }

    // Add to history
    if (state.history[state.history.length - 1] !== trimmed) {
        state.history.push(trimmed);
        const histSize = parseInt(state.env['HISTSIZE'] ?? String(HISTSIZE_DEFAULT), 10);
        if (state.history.length > histSize) {
            state.history = state.history.slice(-histSize);
        }
    }

    // Parse command
    const parsed = parseCommand(trimmed);
    if (!parsed) {
        return 0;
    }

    // Handle background execution
    if (parsed.background) {
        await eprintln('shell: background execution not yet implemented');
        return 1;
    }

    // Execute
    return executeChain(state, parsed);
}

// ============================================================================
// Script Execution
// ============================================================================

async function executeScript(state: ShellState, scriptPath: string): Promise<number> {
    const path = resolvePath(state.cwd, scriptPath);

    let fd: number;
    try {
        fd = await open(path, { read: true });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`shell: ${scriptPath}: ${msg}`);
        return 127;
    }

    try {
        // Read entire script
        const chunks: Uint8Array[] = [];
        while (true) {
            const chunk = await read(fd, 65536);
            if (chunk.length === 0) break;
            chunks.push(chunk);
        }

        const total = chunks.reduce((sum, c) => sum + c.length, 0);
        const content = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
            content.set(chunk, offset);
            offset += chunk.length;
        }

        const script = new TextDecoder().decode(content);
        const lines = script.split('\n');

        let lastExitCode = 0;
        for (const line of lines) {
            if (state.shouldExit) break;
            lastExitCode = await executeLine(state, line);
        }

        return lastExitCode;
    } finally {
        await close(fd);
    }
}

// ============================================================================
// Main
// ============================================================================

async function main(): Promise<void> {
    const args = await getargs();
    const state = await createShellState();

    // Parse shell arguments
    const parsed = parseArgs(args.slice(1), {
        command: { short: 'c', value: true, desc: 'Execute command' },
        version: { short: 'v', long: 'version', desc: 'Show version' },
        help: { short: 'h', long: 'help', desc: 'Show help' },
    });

    // --version
    if (parsed.flags.version) {
        await println(`Monk Shell ${SHELL_VERSION}`);
        await exit(0);
    }

    // --help
    if (parsed.flags.help) {
        await println('Usage: shell [options] [script]');
        await println('');
        await println('Options:');
        await println('  -c CMD    Execute command and exit');
        await println('  -v        Show version');
        await println('  -h        Show this help');
        await exit(0);
    }

    // -c "command"
    if (parsed.flags.command) {
        const cmd = String(parsed.flags.command);
        state.interactive = false;
        const code = await executeLine(state, cmd);
        await exit(code);
    }

    // Script file
    if (parsed.positional.length > 0) {
        state.interactive = false;
        const code = await executeScript(state, parsed.positional[0]);
        await exit(code);
    }

    // Interactive mode
    state.interactive = true;

    // Print welcome
    await println(`Monk Shell ${SHELL_VERSION}`);
    await println('Type "exit" to quit.');
    await println('');

    // Main loop
    while (!state.shouldExit) {
        await printPrompt(state);

        const line = await readline();
        if (line === null) {
            // EOF
            await println('');
            break;
        }

        await executeLine(state, line);
    }

    await exit(state.exitCode);
}

main().catch(async (err) => {
    await eprintln(`shell: ${err.message}`);
    await exit(1);
});
