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
    readdirAll,
    spawn,
    wait,
    open,
    read,
    readText,
    write,
    close,
    exit,
    print,
    println,
    eprintln,
    pipe,
    recv,
    redirect,
    respond,
    ByteReader,
} from '@rom/lib/process';

import {
    parseCommand,
    expandCommandVariables,
    flattenPipeline,
    expandGlobs,
} from '@rom/lib/shell';
import type { ParsedCommand, GlobEntry } from '@rom/lib/shell';

import { parseArgs } from '@rom/lib/args';
import { resolvePath } from '@rom/lib/path';

// ============================================================================
// Constants
// ============================================================================

const SHELL_VERSION = '0.1.0';
const HISTSIZE_DEFAULT = 1000;

// Built-in commands that MUST run in shell process (they modify shell state)
// Keep this list minimal to avoid pipeline bugs with redirect/restore timing
const BUILTIN_COMMANDS = ['cd', 'export', 'exit', 'true', 'false'];

// VFS bin directory for command resolution
const VFS_BIN_PATH = '/bin';

// ============================================================================
// Message-to-File Pump
// ============================================================================

/**
 * Pump messages from a pipe fd to a file fd, converting messages to bytes.
 *
 * MESSAGE→BYTE BOUNDARY: Processes emit Response messages via send(), but
 * files expect raw bytes via write(). This function bridges that gap for
 * shell redirects like `cmd > file`.
 *
 * This function takes ownership of the fds and closes them when done.
 *
 * @param pipeRecvFd - Fd to receive messages from (read end of pipe)
 * @param pipeSendFd - Fd for the write end of the message pipe (closed after spawn)
 * @param fileFd - Fd to write bytes to (opened file)
 */
async function pumpMessagesToFile(
    pipeRecvFd: number,
    pipeSendFd: number,
    fileFd: number,
): Promise<void> {
    // Close the shell's copy of the write end. The spawned process has its own
    // copy. When the process exits, the pipe will signal EOF to the pump.
    await close(pipeSendFd).catch(() => {});

    try {
        const encoder = new TextEncoder();

        for await (const msg of recv(pipeRecvFd)) {
            // Extract text from message
            let text: string | undefined;

            if (msg.op === 'item' && msg.data && typeof msg.data === 'object') {
                const data = msg.data as { text?: string };

                text = data.text;
            }
            else if (msg.op === 'data' && msg.bytes) {
                // Binary data - write directly
                await write(fileFd, msg.bytes);
                continue;
            }

            if (text !== undefined) {
                await write(fileFd, encoder.encode(text));
            }
        }
    }
    finally {
        // Close our fds when pump completes
        await close(pipeRecvFd).catch(() => {});
        await close(fileFd).catch(() => {});
    }
}

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

// Shared ByteReader for stdin - created lazily
let stdinReader: ByteReader | null = null;

function getStdinReader(): ByteReader {
    if (!stdinReader) {
        stdinReader = new ByteReader(read(0));
    }

    return stdinReader;
}

/**
 * Read a line from stdin
 *
 * Uses ByteReader for efficient buffered reading.
 * TODO: Add line editing, history navigation, tab completion
 */
async function readline(): Promise<string | null> {
    const reader = getStdinReader();

    return reader.readLine();
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
        const names = await readdirAll(path);
        const entries: GlobEntry[] = [];

        for (const name of names) {
            const fullPath = path === '/' ? `/${name}` : `${path}/${name}`;

            try {
                const info = await stat(fullPath);

                entries.push({
                    name,
                    isDirectory: info.model === 'folder',
                });
            }
            catch {
                entries.push({ name, isDirectory: false });
            }
        }

        return entries;
    }
    catch {
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
    }
    else {
        const arg0 = args[0];

        if (!arg0) {
            target = state.env['HOME'] ?? '/';
        }
        else if (arg0 === '-') {
            target = state.env['OLDPWD'] ?? state.cwd;
        }
        else {
            target = resolvePath(state.cwd, arg0);
        }
    }

    // Verify directory exists
    try {
        const info = await stat(target);

        if (info.model !== 'folder') {
            await eprintln(`cd: ${args[0] ?? target}: Not a directory`);

            return 1;
        }
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`cd: ${args[0] ?? target}: ${msg}`);

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

async function builtinExit(state: ShellState, args: string[]): Promise<number> {
    const arg0 = args[0];
    const code = arg0 ? parseInt(arg0, 10) : state.lastExitCode;

    state.shouldExit = true;
    state.exitCode = isNaN(code) ? 0 : code;

    return state.exitCode;
}

async function executeBuiltin(
    state: ShellState,
    command: string,
    args: string[],
): Promise<number> {
    // Only commands that MUST modify shell state belong here.
    // Everything else (echo, pwd, history) should be external commands
    // to avoid pipeline redirect/restore timing bugs.
    switch (command) {
        case 'cd':
            return builtinCd(state, args);
        case 'export':
            return builtinExport(state, args);
        case 'exit':
            return builtinExit(state, args);
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
 *
 * Searches VFS for executable TypeScript files.
 */
async function findCommand(command: string, cwd: string): Promise<string | null> {
    // Absolute or relative path (in VFS)
    if (command.startsWith('/') || command.startsWith('./') || command.startsWith('../')) {
        const path = command.startsWith('/') ? command : resolvePath(cwd, command);

        try {
            await stat(path);

            return path;
        }
        catch {
            return null;
        }
    }

    // Search in VFS /bin directory
    const binPath = `${VFS_BIN_PATH}/${command}.ts`;

    try {
        await stat(binPath);

        return binPath;
    }
    catch {
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
/**
 * Spawn an external command and return pid.
 * Does NOT wait for completion - caller must call wait().
 */
async function spawnExternal(
    state: ShellState,
    command: string,
    args: string[],
    stdin?: number,
    stdout?: number,
): Promise<number> {
    const cmdPath = await findCommand(command, state.cwd);

    if (!cmdPath) {
        await eprintln(`${command}: command not found`);

        return -1; // Error indicator
    }

    try {
        const pid = await spawn(cmdPath, {
            args: [command, ...args],
            cwd: state.cwd,
            env: state.env,
            stdin,
            stdout,
        });

        return pid;
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`${command}: ${msg}`);

        return -1;
    }
}

/**
 * Execute an external command (spawn + wait).
 * For non-pipeline use.
 */
async function executeExternal(
    state: ShellState,
    command: string,
    args: string[],
    stdin?: number,
    stdout?: number,
): Promise<number> {
    const pid = await spawnExternal(state, command, args, stdin, stdout);

    if (pid < 0) {
        return 126;
    }

    const status = await wait(pid);

    return status.code;
}

// ============================================================================
// Command Execution
// ============================================================================

/**
 * Execute a single command (no pipes)
 *
 * @param state - Shell state
 * @param cmd - Parsed command
 * @param pipeStdin - Optional stdin fd from pipe
 * @param pipeStdout - Optional stdout fd to pipe
 * @returns Exit code
 */
async function executeSingleCommand(
    state: ShellState,
    cmd: ParsedCommand,
    pipeStdin?: number,
    pipeStdout?: number,
): Promise<number> {
    // Expand globs in arguments
    const expandedArgs = await expandGlobs(cmd.args, state.cwd, readdirForGlob);

    // Track fds we open for redirects (need to close after command)
    const fdsToClose: number[] = [];

    // Determine final stdin/stdout
    let stdin = pipeStdin;
    let stdout = pipeStdout;

    try {
        // Handle input redirect (< file)
        // Input redirect overrides pipe stdin
        if (cmd.inputRedirect) {
            const inputPath = resolvePath(state.cwd, cmd.inputRedirect);

            try {
                const fd = await open(inputPath, { read: true });

                fdsToClose.push(fd);
                stdin = fd;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                await eprintln(`${cmd.command}: ${cmd.inputRedirect}: ${msg}`);

                return 1;
            }
        }

        // Handle output redirect (> file) or append redirect (>> file)
        // Output redirect overrides pipe stdout
        if (cmd.outputRedirect) {
            const outputPath = resolvePath(state.cwd, cmd.outputRedirect);

            try {
                const fd = await open(outputPath, { write: true, create: true, truncate: true });

                fdsToClose.push(fd);
                stdout = fd;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                await eprintln(`${cmd.command}: ${cmd.outputRedirect}: ${msg}`);

                return 1;
            }
        }
        else if (cmd.appendRedirect) {
            const appendPath = resolvePath(state.cwd, cmd.appendRedirect);

            try {
                const fd = await open(appendPath, { write: true, create: true, append: true });

                fdsToClose.push(fd);
                stdout = fd;
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);

                await eprintln(`${cmd.command}: ${cmd.appendRedirect}: ${msg}`);

                return 1;
            }
        }

        // Check for built-in
        if (BUILTIN_COMMANDS.includes(cmd.command)) {
            // Set up redirects for builtin (redirect fd 1 to our output fd)
            const restoreFns: Array<() => Promise<void>> = [];

            if (stdout !== undefined) {
                restoreFns.push(await redirect(1, stdout));
            }

            if (stdin !== undefined) {
                restoreFns.push(await redirect(0, stdin));
            }

            try {
                return await executeBuiltin(state, cmd.command, expandedArgs);
            }
            finally {
                // Restore original fds
                for (const restore of restoreFns) {
                    await restore();
                }

                // For pipeline builtins: close the pipe stdout to signal EOF to reader.
                // This is safe because restore already reverted fd 1 to original.
                if (pipeStdout !== undefined) {
                    await close(pipeStdout).catch(() => {});
                }
            }
        }

        // External command
        return await executeExternal(state, cmd.command, expandedArgs, stdin, stdout);
    }
    finally {
        // Close any fds we opened for redirects
        for (const fd of fdsToClose) {
            await close(fd).catch(() => {});
        }
    }
}

/**
 * Execute a pipeline of commands
 *
 * Pipeline: cmd1 | cmd2 | cmd3
 *
 * Data flows left-to-right through pipes:
 *   cmd1 stdout -> pipe1 -> cmd2 stdin
 *   cmd2 stdout -> pipe2 -> cmd3 stdin
 *
 * Execution model:
 *   1. Create all pipes upfront (N-1 pipes for N commands)
 *   2. Initialize each command IN ORDER (critical for builtins!)
 *   3. Execute all commands concurrently
 *   4. Wait for all to complete
 *   5. Return last command's exit code
 *
 * Why initialize in order?
 *   Builtins run in the shell process and use redirect() to temporarily
 *   change the shell's fd table. If we start commands concurrently,
 *   an external command might spawn while a builtin's redirect is active,
 *   inheriting the wrong stdout fd. This caused the infamous "cat loop" bug
 *   where `echo hello | cat` would loop forever because cat inherited the
 *   pipe's write end (from echo's redirect) instead of console.
 *
 * @returns Exit code of the last command in the pipeline
 */
async function executePipeline(
    state: ShellState,
    pipeline: ParsedCommand[],
): Promise<number> {
    if (pipeline.length === 0) {
        return 0;
    }

    // Single command - no pipes needed
    if (pipeline.length === 1) {
        const cmd = pipeline[0];

        if (!cmd) {
            return 0;
        }

        return executeSingleCommand(state, cmd);
    }

    // =========================================================================
    // Step 1: Create all pipes upfront
    // =========================================================================
    //
    // For pipeline: cmd0 | cmd1 | cmd2
    // We need 2 pipes:
    //   pipes[0] connects cmd0 -> cmd1
    //   pipes[1] connects cmd1 -> cmd2
    //
    // Each pipe is [readFd, writeFd]:
    //   cmd0 writes to pipes[0][1] (writeFd)
    //   cmd1 reads from pipes[0][0] (readFd), writes to pipes[1][1]
    //   cmd2 reads from pipes[1][0]

    const pipes: Array<[number, number]> = [];
    const fdsToClose: number[] = [];

    try {
        for (let i = 0; i < pipeline.length - 1; i++) {
            const [readFd, writeFd] = await pipe();

            pipes.push([readFd, writeFd]);
            fdsToClose.push(readFd, writeFd);
        }

        // =====================================================================
        // Step 2: Initialize commands IN ORDER, collect promises
        // =====================================================================
        //
        // CRITICAL: We must initialize commands sequentially, not concurrently!
        //
        // For builtins: executeSingleCommand does redirect -> execute -> restore.
        //   The redirect temporarily changes shell's fd table. If we spawned
        //   another command during this window, it would inherit wrong fds.
        //
        // For externals: executeSingleCommand spawns a child process.
        //   The spawn captures the current fd table at spawn time.
        //
        // By awaiting each builtin before starting the next command, we ensure
        // externals see the correct (unredirected) shell fd table.
        //
        // Externals don't block here - spawn returns immediately, the child
        // runs concurrently. We just collect the wait() promise.

        // Track spawned external processes so we can wait for them later
        const spawnedPids: number[] = [];
        const exitCodes: number[] = [];
        const pumpPromises: Promise<void>[] = [];

        for (let i = 0; i < pipeline.length; i++) {
            const cmd = pipeline[i];

            if (!cmd) {
                continue;
            }

            const isFirst = i === 0;
            const isLast = i === pipeline.length - 1;

            // Determine this command's stdin/stdout:
            //   - First command: stdin = shell's stdin (undefined means inherit)
            //   - Last command: stdout = shell's stdout (undefined means inherit)
            //   - Middle commands: both connected to pipes
            const prevPipe = pipes[i - 1];
            const currPipe = pipes[i];
            const stdinFd = isFirst ? undefined : (prevPipe ? prevPipe[0] : undefined);
            let stdoutFd = isLast ? undefined : (currPipe ? currPipe[1] : undefined);

            if (BUILTIN_COMMANDS.includes(cmd.command)) {
                // =============================================================
                // Builtin: execute completely (redirect -> run -> restore)
                // =============================================================
                // We await the entire builtin so redirect/restore completes
                // before the next command spawns.
                const exitCode = await executeSingleCommand(state, cmd, stdinFd, stdoutFd);

                exitCodes.push(exitCode);
                spawnedPids.push(-1); // Placeholder for uniform indexing
            }
            else {
                // =============================================================
                // External: expand globs, then spawn (but don't wait yet)
                // =============================================================
                //
                // MESSAGE→BYTE BOUNDARY: If there's an output redirect to a file,
                // we need to bridge the gap between message-based process I/O and
                // byte-based file I/O. Create a message pipe, spawn the process
                // with the pipe's write end as stdout, then pump messages to the file.

                let fileFd: number | undefined;
                let pipeRecvFd: number | undefined;
                let pipeSendFd: number | undefined;

                // Handle output redirect (> file) or append redirect (>> file)
                if (cmd.outputRedirect || cmd.appendRedirect) {
                    const redirectPath = cmd.outputRedirect || cmd.appendRedirect;
                    const outputPath = resolvePath(state.cwd, redirectPath!);
                    const appendMode = !!cmd.appendRedirect;

                    try {
                        // Open the output file
                        fileFd = await open(outputPath, {
                            write: true,
                            create: true,
                            truncate: !appendMode,
                            append: appendMode,
                        });
                        // NOTE: Don't add fileFd to fdsToClose - pump takes ownership

                        // Create a message pipe for the process's stdout
                        const [recvFd, sendFd] = await pipe();

                        pipeRecvFd = recvFd;
                        pipeSendFd = sendFd;
                        stdoutFd = sendFd;
                        // NOTE: Don't add pipe fds to fdsToClose - pump takes ownership
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);

                        await eprintln(`${cmd.command}: ${redirectPath}: ${msg}`);
                        exitCodes.push(1);
                        spawnedPids.push(-1);
                        continue;
                    }
                }

                const expandedArgs = await expandGlobs(cmd.args, state.cwd, readdirForGlob);
                const pid = await spawnExternal(state, cmd.command, expandedArgs, stdinFd, stdoutFd);

                spawnedPids.push(pid);
                exitCodes.push(pid < 0 ? 126 : -1); // -1 means "need to wait"

                // Start the message→file pump if we set one up
                // Pump takes ownership of all three fds and closes them when done
                if (fileFd !== undefined && pipeRecvFd !== undefined && pipeSendFd !== undefined) {
                    pumpPromises.push(
                        pumpMessagesToFile(pipeRecvFd, pipeSendFd, fileFd).catch(() => {}),
                    );
                }
            }
        }

        // =====================================================================
        // Step 2b: Close shell's pipe fd copies
        // =====================================================================
        //
        // NOW we can safely close our pipe fd copies. All spawn() calls have
        // completed, so children have inherited their fd copies. Closing ours
        // ensures the pipe will signal EOF when the writing child exits.
        //
        // This is the key fix for the "cat loop" bug: without closing these,
        // cat would never see EOF because the shell still held the write end.

        for (const fd of fdsToClose) {
            await close(fd).catch(() => {});
        }

        fdsToClose.length = 0;

        // =====================================================================
        // Step 3: Wait for all external commands to complete
        // =====================================================================
        //
        // Builtins already completed above (exitCodes has their values).
        // Externals are running concurrently - wait for each and update exitCodes.

        const waitPromises: Promise<void>[] = [];

        for (let i = 0; i < spawnedPids.length; i++) {
            const pid = spawnedPids[i];

            if (pid !== undefined && pid > 0) {
                // This is an external command that needs waiting
                const idx = i; // Capture for closure

                waitPromises.push(
                    wait(pid).then(status => {
                        exitCodes[idx] = status.code;
                    }).catch(() => {
                        exitCodes[idx] = 126;
                    }),
                );
            }
        }

        // Wait for external processes AND message pumps
        await Promise.all([...waitPromises, ...pumpPromises]);

        // =====================================================================
        // Step 4: Return exit code of last command
        // =====================================================================
        //
        // Pipeline exit code is the exit code of the LAST command.
        // This is standard shell behavior.

        const lastExitCode = exitCodes[exitCodes.length - 1];

        return lastExitCode ?? 0;
    }
    finally {
        // Cleanup on error - close any remaining pipe fds
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
    cmd: ParsedCommand,
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
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`shell: ${scriptPath}: ${msg}`);

        return 127;
    }

    try {
        // Read entire script using new streaming API
        const script = await readText(fd);
        const lines = script.split('\n');

        let lastExitCode = 0;

        for (const line of lines) {
            if (state.shouldExit) {
                break;
            }

            lastExitCode = await executeLine(state, line);
        }

        return lastExitCode;
    }
    finally {
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
        const scriptPath = parsed.positional[0];

        if (scriptPath) {
            state.interactive = false;
            const code = await executeScript(state, scriptPath);

            await exit(code);
        }
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

main().catch(async err => {
    await eprintln(`shell: ${err.message}`);
    await exit(1);
});
