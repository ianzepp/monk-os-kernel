/**
 * TTY Command Executor
 *
 * Core execution engine for TTY commands. Handles:
 * - Command parsing and variable expansion
 * - Glob expansion
 * - Pipeline execution (|)
 * - Command chaining (&&, ||)
 * - Input/output redirection
 * - Background execution
 *
 * This is the single execution path used by:
 * - Interactive commands
 * - source/. command
 * - .profile loading
 * - Background processes
 */

import type { Session, ParsedCommand, CommandIO } from './types.js';
import type { FS } from '@src/lib/fs/index.js';
import type { CommandHandler } from './commands/shared.js';
import { parseCommand, expandVariables, resolvePath } from './parser.js';
import { runTransaction } from '@src/lib/transaction.js';
import { spawnProcess } from '@src/lib/process.js';
import { PassThrough } from 'node:stream';
import { applySessionMounts } from './profile.js';
import { shouldExecute } from './commands/control.js';

// =============================================================================
// Lazy Command Registry
// =============================================================================

/**
 * Lazy-loaded command registry to avoid circular dependencies.
 * The commands module imports many command files, which may import
 * modules that eventually import system.ts -> ai.ts -> executor.ts.
 */
let _commands: Record<string, CommandHandler> | null = null;
let _commandNames: string[] | null = null;

/**
 * Get the commands registry (lazy-loaded)
 */
export async function getCommands(): Promise<Record<string, CommandHandler>> {
    if (!_commands) {
        const mod = await import('./commands.js');
        _commands = mod.commands;
        _commandNames = Object.keys(_commands).filter(name => /^[a-zA-Z]/.test(name));
    }
    return _commands;
}

/**
 * Get command names for /bin mount (synchronous, returns cached)
 * Returns empty array if commands haven't been loaded yet.
 */
export function getCommandNamesSync(): string[] {
    return _commandNames || [];
}

/** Commands that manage control flow - always execute regardless of conditional state */
const CONTROL_FLOW_COMMANDS = ['if', 'then', 'else', 'elif', 'fi'];

/**
 * Options for executeLine
 */
export interface ExecuteOptions {
    /** Add command to history (default: false) */
    addToHistory?: boolean;
    /** Wrap in transaction (default: true) */
    useTransaction?: boolean;
    /** Existing FS if already in transaction */
    fs?: FS;
    /** Abort signal for cancellation */
    signal?: AbortSignal;
}

/**
 * Execute a command line
 *
 * Main entry point for command execution. Used by:
 * - Interactive shell (with addToHistory: true)
 * - source command (with fs passed, useTransaction: false)
 * - .profile loading (with fs passed, useTransaction: false)
 *
 * @param session - User session
 * @param input - Command line to execute
 * @param io - I/O streams
 * @param options - Execution options
 * @returns Exit code
 */
export async function executeLine(
    session: Session,
    input: string,
    io: CommandIO,
    options: ExecuteOptions = {}
): Promise<number> {
    const {
        addToHistory = false,
        useTransaction = true,
        fs: existingFs,
        signal,
    } = options;

    const parsed = parseCommand(input);
    if (!parsed) return 0;

    // Add to history if requested (interactive mode)
    if (addToHistory) {
        if (session.history[session.history.length - 1] !== input) {
            session.history.push(input);
            // Trim to HISTSIZE
            const histSize = parseInt(session.env['HISTSIZE'] || '1000', 10) || 1000;
            if (session.history.length > histSize) {
                session.history = session.history.slice(-histSize);
            }
        }
        session.historyIndex = -1;
        session.historyBuffer = '';
    }

    // Handle background execution
    if (parsed.background) {
        return executeBackground(session, parsed, io);
    }

    // If we already have a FS (inside a transaction), use it directly
    if (existingFs) {
        return executeChain(session, parsed, existingFs, io, signal);
    }

    // Check if we need a transaction
    if (!useTransaction || !commandTreeNeedsTransaction(parsed)) {
        return executeChain(session, parsed, null, io, signal);
    }

    // Wrap in transaction
    if (!session.systemInit) {
        io.stderr.write('Error: Not authenticated\n');
        return 1;
    }

    let exitCode = 0;
    await runTransaction(session.systemInit, async (system) => {
        applySessionMounts(session, system.fs, system);
        exitCode = await executeChain(session, parsed, system.fs, io, signal);
    });

    return exitCode;
}

/**
 * Execute a command chain (handles &&, ||)
 */
export async function executeChain(
    session: Session,
    parsed: ParsedCommand,
    fs: FS | null,
    io: CommandIO,
    signal?: AbortSignal
): Promise<number> {
    // Build pipeline and expand variables
    const pipeline = buildPipeline(parsed, session.env);

    // Expand globs if we have filesystem access
    if (fs) {
        await expandPipelineGlobs(pipeline, session.cwd, fs);
    }

    // Execute the pipeline
    const exitCode = await executePipeline(session, pipeline, fs, io, signal);

    // Update $?
    session.env['?'] = String(exitCode);

    // Handle && chain (run next if this succeeded)
    if (parsed.andThen && exitCode === 0) {
        return executeChain(session, parsed.andThen, fs, io, signal);
    }

    // Handle || chain (run next if this failed)
    if (parsed.orElse && exitCode !== 0) {
        return executeChain(session, parsed.orElse, fs, io, signal);
    }

    return exitCode;
}

/**
 * Execute a pipeline of commands
 */
async function executePipeline(
    session: Session,
    pipeline: ParsedCommand[],
    fs: FS | null,
    io: CommandIO,
    signal?: AbortSignal
): Promise<number> {
    if (pipeline.length === 0) return 0;

    const firstCmd = pipeline[0];
    const lastCmd = pipeline[pipeline.length - 1];
    const hasInputRedirect = firstCmd.inputRedirect;
    const hasOutputRedirect = lastCmd.outputRedirect || lastCmd.appendRedirect;

    // Single command case
    if (pipeline.length === 1) {
        return executeSingleCommand(session, firstCmd, fs, io, signal, hasInputRedirect, hasOutputRedirect);
    }

    // Multi-command pipeline
    return executeMultiCommandPipeline(session, pipeline, fs, io, signal, hasInputRedirect, hasOutputRedirect);
}

/**
 * Execute a single command (no pipes)
 */
async function executeSingleCommand(
    session: Session,
    cmd: ParsedCommand,
    fs: FS | null,
    io: CommandIO,
    signal?: AbortSignal,
    hasInputRedirect?: string,
    hasOutputRedirect?: string | boolean
): Promise<number> {
    // Lazy-load commands registry
    const commands = await getCommands();
    const handler = commands[cmd.command];
    if (!handler) {
        // Check if we should execute - if not, silently skip unknown commands too
        if (!CONTROL_FLOW_COMMANDS.includes(cmd.command) && !shouldExecute(session)) {
            return 0;
        }
        io.stderr.write(`${cmd.command}: command not found\n`);
        return 127;
    }

    // Control flow commands always execute (they manage the conditional state)
    // Other commands only execute if the current conditional context allows it
    if (!CONTROL_FLOW_COMMANDS.includes(cmd.command) && !shouldExecute(session)) {
        return 0;
    }

    const cmdIO = createIO(signal);

    // Handle input redirect
    if (hasInputRedirect && fs) {
        const success = await handleInputRedirect(fs, cmd.inputRedirect!, session.cwd, cmdIO);
        if (!success) {
            io.stderr.write(`${cmd.command}: ${cmd.inputRedirect}: No such file\n`);
            return 1;
        }
    } else {
        // Pass through stdin from parent
        io.stdin.pipe(cmdIO.stdin);
    }

    // Handle output
    if (hasOutputRedirect && fs) {
        // Redirect to file
        cmdIO.stderr.on('data', (chunk) => io.stderr.write(chunk));

        try {
            const handlerPromise = handler(session, fs, cmd.args, cmdIO).then((code) => {
                cmdIO.stdout.end();
                return code;
            });

            const redirectPath = cmd.outputRedirect || cmd.appendRedirect!;
            const [exitCode] = await Promise.all([
                handlerPromise,
                handleOutputRedirect(fs, redirectPath, session.cwd, cmdIO, !!cmd.appendRedirect),
            ]);
            return exitCode;
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            io.stderr.write(`Error: ${message}\n`);
            return 1;
        }
    } else {
        // Pipe to parent IO
        cmdIO.stdout.on('data', (chunk) => io.stdout.write(chunk));
        cmdIO.stderr.on('data', (chunk) => io.stderr.write(chunk));

        try {
            return await handler(session, fs, cmd.args, cmdIO);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            io.stderr.write(`Error: ${message}\n`);
            return 1;
        }
    }
}

/**
 * Execute a multi-command pipeline
 */
async function executeMultiCommandPipeline(
    session: Session,
    pipeline: ParsedCommand[],
    fs: FS | null,
    io: CommandIO,
    signal?: AbortSignal,
    hasInputRedirect?: string,
    hasOutputRedirect?: string | boolean
): Promise<number> {
    // Lazy-load commands registry once for the pipeline
    const commands = await getCommands();

    let lastExitCode = 0;
    let previousOutput = '';

    for (let i = 0; i < pipeline.length; i++) {
        const cmd = pipeline[i];
        const handler = commands[cmd.command];

        if (!handler) {
            io.stderr.write(`${cmd.command}: command not found\n`);
            return 127;
        }

        const cmdIO = createIO(signal);
        const isFirst = i === 0;
        const isLast = i === pipeline.length - 1;

        // Handle stdin
        if (isFirst && hasInputRedirect && fs) {
            const success = await handleInputRedirect(fs, cmd.inputRedirect!, session.cwd, cmdIO);
            if (!success) {
                io.stderr.write(`${cmd.command}: ${cmd.inputRedirect}: No such file\n`);
                return 1;
            }
        } else if (previousOutput) {
            cmdIO.stdin.end(previousOutput);
        } else {
            cmdIO.stdin.end();
        }

        // Handle stdout
        if (isLast) {
            if (hasOutputRedirect && fs) {
                cmdIO.stderr.on('data', (chunk) => io.stderr.write(chunk));

                try {
                    const handlerPromise = handler(session, fs, cmd.args, cmdIO).then((code) => {
                        cmdIO.stdout.end();
                        return code;
                    });

                    const redirectPath = cmd.outputRedirect || cmd.appendRedirect!;
                    const [exitCode] = await Promise.all([
                        handlerPromise,
                        handleOutputRedirect(fs, redirectPath, session.cwd, cmdIO, !!cmd.appendRedirect),
                    ]);
                    lastExitCode = exitCode;
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    io.stderr.write(`Error: ${message}\n`);
                    lastExitCode = 1;
                }
            } else {
                cmdIO.stdout.on('data', (chunk) => io.stdout.write(chunk));
                cmdIO.stderr.on('data', (chunk) => io.stderr.write(chunk));

                try {
                    lastExitCode = await handler(session, fs, cmd.args, cmdIO);
                } catch (err) {
                    const message = err instanceof Error ? err.message : String(err);
                    io.stderr.write(`Error: ${message}\n`);
                    lastExitCode = 1;
                }
            }
        } else {
            // Middle command - collect stdout for next command
            cmdIO.stderr.on('data', (chunk) => io.stderr.write(chunk));

            try {
                const handlerPromise = handler(session, fs, cmd.args, cmdIO).then((code) => {
                    cmdIO.stdout.end();
                    return code;
                });

                const [exitCode, output] = await Promise.all([
                    handlerPromise,
                    collectStream(cmdIO.stdout),
                ]);
                lastExitCode = exitCode;
                previousOutput = output;
            } catch (err) {
                const message = err instanceof Error ? err.message : String(err);
                io.stderr.write(`Error: ${message}\n`);
                return 1;
            }
        }
    }

    return lastExitCode;
}

/**
 * Execute a command in the background
 */
async function executeBackground(
    session: Session,
    parsed: ParsedCommand,
    io: CommandIO
): Promise<number> {
    if (!session.systemInit) {
        io.stderr.write('Error: Not authenticated\n');
        return 1;
    }

    const cmdline = [parsed.command, ...parsed.args];

    try {
        const pid = await spawnProcess(
            session.systemInit,
            {
                type: 'command',
                comm: parsed.command,
                cmdline,
                cwd: session.cwd,
                environ: session.env,
                ppid: session.pid || undefined,
            },
            async (system, _cmdline, processIO) => {
                // Create session copy for background execution
                const bgSession = { ...session };

                // Full execution through the same path
                applySessionMounts(bgSession, system.fs, system);
                return executeChain(bgSession, parsed, system.fs, {
                    stdin: processIO.stdin,
                    stdout: processIO.stdout,
                    stderr: processIO.stderr,
                    signal: processIO.signal,
                }, processIO.signal);
            }
        );

        io.stdout.write(`[1] ${pid}\n`);
        return 0;
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        io.stderr.write(`Error spawning background process: ${message}\n`);
        return 1;
    }
}

/**
 * Build pipeline from parsed command (handles | only)
 */
function buildPipeline(parsed: ParsedCommand, env: Record<string, string>): ParsedCommand[] {
    const pipeline: ParsedCommand[] = [];
    let current: ParsedCommand | undefined = parsed;

    while (current) {
        // Expand variables in args
        current.args = current.args.map(arg => expandVariables(arg, env));
        pipeline.push(current);
        current = current.pipe;
    }

    return pipeline;
}

/**
 * Check if command tree needs a transaction
 */
function commandTreeNeedsTransaction(parsed: ParsedCommand): boolean {
    const noTransactionCommands = [
        'echo', 'env', 'export', 'clear', 'help', 'pwd', 'whoami',
        'exit', 'logout', 'quit', 'true', 'false', 'test', '[',
        'if', 'then', 'else', 'elif', 'fi',
    ];

    let current: ParsedCommand | undefined = parsed;
    while (current) {
        if (!noTransactionCommands.includes(current.command)) {
            return true;
        }
        current = current.pipe;
    }

    if (parsed.andThen && commandTreeNeedsTransaction(parsed.andThen)) {
        return true;
    }

    if (parsed.orElse && commandTreeNeedsTransaction(parsed.orElse)) {
        return true;
    }

    return false;
}

/**
 * Check if string contains glob characters
 */
function hasGlobChars(s: string): boolean {
    return /[*?[\]]/.test(s);
}

/**
 * Convert glob pattern to regex
 */
function globToRegex(pattern: string): RegExp {
    const escaped = pattern
        .replace(/[.+^${}()|\\]/g, '\\$&')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
    return new RegExp(`^${escaped}$`);
}

/**
 * Expand glob patterns in arguments
 */
async function expandGlobs(args: string[], cwd: string, fs: FS): Promise<string[]> {
    const result: string[] = [];

    for (const arg of args) {
        if (!hasGlobChars(arg)) {
            result.push(arg);
            continue;
        }

        const lastSlash = arg.lastIndexOf('/');
        let dir: string;
        let pattern: string;

        if (lastSlash === -1) {
            dir = cwd;
            pattern = arg;
        } else if (lastSlash === 0) {
            dir = '/';
            pattern = arg.slice(1);
        } else {
            dir = resolvePath(cwd, arg.slice(0, lastSlash));
            pattern = arg.slice(lastSlash + 1);
        }

        if (!hasGlobChars(pattern)) {
            result.push(arg);
            continue;
        }

        try {
            const entries = await fs.readdir(dir);
            const regex = globToRegex(pattern);
            const matches = entries
                .filter(e => regex.test(e.name))
                .map(e => {
                    const path = dir === cwd ? e.name : `${dir}/${e.name}`;
                    return e.type === 'directory' ? path + '/' : path;
                })
                .sort();

            if (matches.length > 0) {
                result.push(...matches);
            } else {
                result.push(arg);
            }
        } catch {
            result.push(arg);
        }
    }

    return result;
}

/**
 * Expand globs in pipeline
 */
async function expandPipelineGlobs(pipeline: ParsedCommand[], cwd: string, fs: FS): Promise<void> {
    for (const cmd of pipeline) {
        cmd.args = await expandGlobs(cmd.args, cwd, fs);
    }
}

/**
 * Create CommandIO with fresh streams
 */
export function createIO(signal?: AbortSignal): CommandIO {
    return {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        signal,
    };
}

/**
 * Collect stream data into string
 */
async function collectStream(stream: PassThrough): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks).toString();
}

/**
 * Handle input redirect
 */
async function handleInputRedirect(
    fs: FS,
    path: string,
    cwd: string,
    io: CommandIO
): Promise<boolean> {
    try {
        const resolved = resolvePath(cwd, path);
        const content = await fs.read(resolved);
        io.stdin.end(content.toString());
        return true;
    } catch {
        return false;
    }
}

/**
 * Handle output redirect
 */
async function handleOutputRedirect(
    fs: FS,
    path: string,
    cwd: string,
    io: CommandIO,
    append: boolean
): Promise<void> {
    const resolved = resolvePath(cwd, path);
    const output = await collectStream(io.stdout);

    if (append) {
        try {
            const existing = await fs.read(resolved);
            await fs.write(resolved, existing.toString() + output);
        } catch {
            await fs.write(resolved, output);
        }
    } else {
        await fs.write(resolved, output);
    }
}
