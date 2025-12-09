/**
 * Prior - Main AI Process
 *
 * The Prior is the primary AI process that starts when Monk OS boots.
 * It listens on a TCP port for external instructions (from Abbot CLI,
 * Claude Code, or other clients) and coordinates AI work within the OS.
 *
 * Protocol: JSON lines over TCP
 * - Client sends: {"task": "...", "context": {...}}\n
 * - Prior responds: {"status": "ok"|"error", "result": "...", ...}\n
 *
 * @module rom/bin/prior
 */

import {
    call,
    syscall,
    onSignal,
    onTick,
    subscribeTicks,
    println,
    eprintln,
    getpid,
    sleep,
    readFile,
    writeFile,
    appendFile,
    mkdir,
    stat,
    spawn,
    wait,
    pipe,
    close,
    recv,
    getcwd,
    readdirAll,
} from '@rom/lib/process/index.js';
import type { Response } from '@rom/lib/process/types.js';
import {
    parseCommand,
    flattenPipeline,
    expandGlobs,
    type GlobEntry,
} from '@rom/lib/shell/index.js';

// =============================================================================
// CONFIGURATION
// =============================================================================

const DEFAULT_PORT = 7777;
const DEFAULT_MODEL = 'claude-sonnet-4';
const SYSTEM_PROMPT_PATH = '/etc/prior/system.txt';

// Memory paths
const MEMORY_DIR = '/var/prior';
const IDENTITY_PATH = '/var/prior/identity.txt';
const SESSION_LOG_PATH = '/var/prior/session.log';
const CONTEXT_PATH = '/var/prior/context.txt';

// =============================================================================
// STATE
// =============================================================================

let systemPrompt: string | undefined;
let identity: string | undefined;
let memoryContext: string | undefined;
let tickBusy = false;

// Spawned subagent tracking
interface SpawnedAgent {
    id: string;
    task: string;
    model: string;
    promise: Promise<TaskResult>;
    result?: TaskResult;
    done: boolean;
}

const spawnedAgents = new Map<string, SpawnedAgent>();

function generateSpawnId(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let id = '';
    for (let i = 0; i < 8; i++) {
        id += chars[Math.floor(Math.random() * chars.length)];
    }
    return `spawn:${id}`;
}

// =============================================================================
// TYPES
// =============================================================================

interface Instruction {
    task: string;
    context?: Record<string, unknown>;
    model?: string;
}

interface TaskResult {
    status: 'ok' | 'error';
    result?: string;
    error?: string;
    model?: string;
    duration_ms?: number;
}

interface CompletionResponse {
    text: string;
    model: string;
    usage?: {
        prompt_tokens: number;
        completion_tokens: number;
        total_tokens: number;
    };
}

interface ExecResult {
    stdout: string;
    stderr: string;
    code: number;
}

// Maximum iterations for agentic loop (prevent runaway)
const MAX_EXEC_ITERATIONS = 10;

// =============================================================================
// SOCKET I/O HELPERS
// =============================================================================

/**
 * Read all data from a socket until connection closes or newline received.
 * Returns the data as a string.
 */
async function readSocket(socketFd: number): Promise<string> {
    const chunks: Uint8Array[] = [];

    for await (const response of syscall('handle:send', socketFd, { op: 'recv' })) {
        if (response.op === 'data' && response.bytes) {
            chunks.push(response.bytes);

            // Check for newline (JSON lines protocol)
            const lastChunk = response.bytes;
            if (lastChunk.includes(10)) { // \n
                break;
            }
        }
        else if (response.op === 'done' || response.op === 'ok') {
            break;
        }
        else if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new Error(`Socket read error: ${err.code} - ${err.message}`);
        }
    }

    // Concatenate chunks
    const totalLength = chunks.reduce((sum, c) => sum + c.length, 0);
    const result = new Uint8Array(totalLength);
    let offset = 0;

    for (const chunk of chunks) {
        result.set(chunk, offset);
        offset += chunk.length;
    }

    return new TextDecoder().decode(result).trim();
}

/**
 * Write data to a socket.
 */
async function writeSocket(socketFd: number, data: string): Promise<void> {
    const bytes = new TextEncoder().encode(data);

    for await (const response of syscall('handle:send', socketFd, { op: 'send', data: { data: bytes } })) {
        if (response.op === 'ok') {
            return;
        }
        else if (response.op === 'error') {
            const err = response.data as { code: string; message: string };
            throw new Error(`Socket write error: ${err.code} - ${err.message}`);
        }
    }
}

// =============================================================================
// SESSION LOGGING
// =============================================================================

/**
 * Log a task exchange to the session log.
 */
async function logSession(task: string, result: string, status: 'ok' | 'error'): Promise<void> {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] TASK: ${task.slice(0, 200)}${task.length > 200 ? '...' : ''}\n[${timestamp}] ${status.toUpperCase()}: ${result.slice(0, 500)}${result.length > 500 ? '...' : ''}\n\n`;

    try {
        await appendFile(SESSION_LOG_PATH, entry);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await eprintln(`prior: failed to log session: ${message}`);
    }
}

// =============================================================================
// COMMAND EXECUTION
// =============================================================================

/**
 * Helper for glob expansion - reads directory entries.
 */
async function readdirForGlob(path: string): Promise<GlobEntry[]> {
    try {
        const entries = await readdirAll(path);
        const result: GlobEntry[] = [];

        for (const entry of entries) {
            result.push({
                name: entry.name,
                isDirectory: entry.model === 'folder',
            });
        }

        return result;
    }
    catch {
        return [];
    }
}

/**
 * Find command in /bin directory.
 */
async function findCommand(command: string): Promise<string | null> {
    // Absolute path
    if (command.startsWith('/')) {
        try {
            await stat(command);
            return command;
        }
        catch {
            return null;
        }
    }

    // Search in /bin
    const binPath = `/bin/${command}.ts`;

    try {
        await stat(binPath);
        return binPath;
    }
    catch {
        return null;
    }
}

/**
 * Execute commands sequentially (for && and ;) and concatenate output.
 *
 * Unlike pipes, each command runs independently and outputs are combined.
 */
async function execSequential(commands: string[]): Promise<ExecResult> {
    // Split on && and ; to get individual commands
    const allCommands: string[] = [];
    for (const cmd of commands) {
        const parts = cmd.split(/\s*(?:&&|;)\s*/);
        for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed) {
                allCommands.push(trimmed);
            }
        }
    }

    const outputs: string[] = [];
    let lastCode = 0;

    for (const cmd of allCommands) {
        // Run each command as a single-element pipeline
        const result = await exec([cmd]);
        if (result.stdout) {
            outputs.push(result.stdout);
        }
        if (result.stderr) {
            outputs.push(result.stderr);
        }
        lastCode = result.code;

        // For &&, stop on first failure
        if (result.code !== 0 && commands.some(c => c.includes('&&'))) {
            break;
        }
    }

    return {
        stdout: outputs.join('\n'),
        stderr: '',
        code: lastCode,
    };
}

/**
 * Execute parallel commands (for &) and concatenate output.
 *
 * Each segment separated by & runs in parallel.
 */
async function execParallel(commands: string[]): Promise<ExecResult> {
    // Split on & to get parallel segments
    const segments: string[] = [];
    for (const cmd of commands) {
        const parts = cmd.split(/\s*&\s*/);
        for (const part of parts) {
            const trimmed = part.trim();
            // Skip 'wait' - it's a shell builtin we don't need
            if (trimmed && trimmed !== 'wait') {
                segments.push(trimmed);
            }
        }
    }

    if (segments.length === 0) {
        return { stdout: '', stderr: '', code: 0 };
    }

    // Run all segments in parallel
    const promises = segments.map(segment => exec([segment]));
    const results = await Promise.all(promises);

    // Combine outputs
    const outputs: string[] = [];
    let lastCode = 0;

    for (const result of results) {
        if (result.stdout) {
            outputs.push(result.stdout);
        }
        if (result.stderr) {
            outputs.push(result.stderr);
        }
        if (result.code !== 0) {
            lastCode = result.code;
        }
    }

    return {
        stdout: outputs.join('\n'),
        stderr: '',
        code: lastCode,
    };
}

/**
 * Execute a pipeline of commands and capture output.
 *
 * @param commands - Array of shell command strings (e.g., ["ls -la", "grep foo"])
 * @returns Execution result with stdout, stderr, and exit code
 */
async function exec(commands: string[]): Promise<ExecResult> {
    if (commands.length === 0) {
        return { stdout: '', stderr: '', code: 0 };
    }

    // Check for & (parallel execution)
    const hasParallel = commands.some(cmd => /\s*&\s*/.test(cmd) && !/&&/.test(cmd));

    if (hasParallel) {
        return execParallel(commands);
    }

    // Check for && or ; (sequential execution with concatenated output)
    // These run commands independently and combine output
    const hasSequential = commands.some(cmd => /\s*(?:&&|;)\s*/.test(cmd));

    if (hasSequential) {
        return execSequential(commands);
    }

    // Normalize pipe syntax: split "cmd1 | cmd2" into array elements
    const normalized: string[] = [];
    for (const cmd of commands) {
        const parts = cmd.split(/\s*\|\s*/);
        for (const part of parts) {
            const trimmed = part.trim();
            if (trimmed) {
                normalized.push(trimmed);
            }
        }
    }

    if (normalized.length === 0) {
        return { stdout: '', stderr: '', code: 0 };
    }

    commands = normalized;

    const cwd = await getcwd();

    // Parse all commands
    const parsedCommands = commands.map(cmd => parseCommand(cmd)).filter(Boolean);

    if (parsedCommands.length === 0) {
        return { stdout: '', stderr: 'No valid commands', code: 1 };
    }

    // For capturing final output, we create a pipe
    // The last command writes to the pipe, we read from it
    const [outputReadFd, outputWriteFd] = await pipe();

    // Track all pipes for cleanup
    const pipeFds: number[] = [outputReadFd, outputWriteFd];
    const spawnedPids: number[] = [];

    try {
        // Create inter-command pipes (N-1 pipes for N commands)
        const interPipes: Array<[number, number]> = [];

        for (let i = 0; i < parsedCommands.length - 1; i++) {
            const [readFd, writeFd] = await pipe();
            interPipes.push([readFd, writeFd]);
            pipeFds.push(readFd, writeFd);
        }

        // Spawn each command
        for (let i = 0; i < parsedCommands.length; i++) {
            const parsed = parsedCommands[i]!;
            const pipeline = flattenPipeline(parsed);
            const cmd = pipeline[0]!;

            // Expand globs in arguments
            const expandedArgs = await expandGlobs(cmd.args, cwd, readdirForGlob);

            // Find command
            const cmdPath = await findCommand(cmd.command);

            if (!cmdPath) {
                return { stdout: '', stderr: `${cmd.command}: command not found`, code: 127 };
            }

            // Determine stdin/stdout for this command
            const isFirst = i === 0;
            const isLast = i === parsedCommands.length - 1;

            // stdin: first command inherits, others read from previous pipe
            const stdinFd = isFirst ? undefined : interPipes[i - 1]![0];

            // stdout: last command writes to output pipe, others write to next pipe
            const stdoutFd = isLast ? outputWriteFd : interPipes[i]![1];

            const pid = await spawn(cmdPath, {
                args: [cmd.command, ...expandedArgs],
                cwd,
                stdin: stdinFd,
                stdout: stdoutFd,
            });

            spawnedPids.push(pid);
        }

        // Close write ends of pipes in parent (so reads see EOF when children exit)
        await close(outputWriteFd);

        for (const [, writeFd] of interPipes) {
            await close(writeFd);
        }

        // Read output from the final command
        const outputChunks: string[] = [];

        for await (const response of recv(outputReadFd)) {
            if (response.op === 'item' && response.data) {
                const data = response.data as { text?: string };
                if (data.text) {
                    outputChunks.push(data.text);
                }
            }
            else if (response.op === 'done' || response.op === 'error') {
                break;
            }
        }

        // Wait for all processes
        let lastCode = 0;

        for (const pid of spawnedPids) {
            const status = await wait(pid);
            lastCode = status.code;
        }

        // Close remaining read fds
        await close(outputReadFd).catch(() => {});

        for (const [readFd] of interPipes) {
            await close(readFd).catch(() => {});
        }

        return {
            stdout: outputChunks.join(''),
            stderr: '',
            code: lastCode,
        };
    }
    catch (err) {
        // Cleanup on error
        for (const fd of pipeFds) {
            await close(fd).catch(() => {});
        }

        const message = err instanceof Error ? err.message : String(err);
        return { stdout: '', stderr: message, code: 1 };
    }
}

// =============================================================================
// COMMAND PARSING
// =============================================================================

interface ParsedBangCommand {
    type: 'exec' | 'call' | 'stm' | 'ltm' | 'help' | 'spawn' | 'wait';
    args: unknown;
}

const HELP_PATH = '/etc/prior/help.txt';

/**
 * Parse ! commands from LLM response.
 *
 * Supported commands:
 *   !exec ["ls -la", "grep foo"]           # shell pipeline
 *   !call syscall:name arg1 arg2 ...       # direct syscall
 *   !stm ...                               # short-term memory (reserved)
 *   !ltm ...                               # long-term memory (reserved)
 *
 * @param text - LLM response text
 * @returns Array of parsed commands, or null if none found
 */
function parseBangCommands(text: string): ParsedBangCommand[] | null {
    const results: ParsedBangCommand[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();

        // !exec ["cmd1", "cmd2", ...]
        const execMatch = trimmed.match(/^!exec\s+(\[.+\])/);
        if (execMatch && execMatch[1]) {
            try {
                const commands = JSON.parse(execMatch[1]) as unknown;
                if (Array.isArray(commands) && commands.every(c => typeof c === 'string')) {
                    results.push({ type: 'exec', args: commands });
                }
            }
            catch {
                // Invalid JSON, skip
            }
            continue;
        }

        // !call syscall:name arg1 arg2 ... OR !call syscall:name [arg1, arg2]
        const callMatch = trimmed.match(/^!call\s+(\S+)\s*(.*)/);
        if (callMatch && callMatch[1]) {
            const syscallName = callMatch[1];
            const argsStr = (callMatch[2] || '').trim();

            // Check if args are a JSON array
            let args: unknown[];
            if (argsStr.startsWith('[')) {
                try {
                    const parsed = JSON.parse(argsStr);
                    args = Array.isArray(parsed) ? parsed : [parsed];
                }
                catch {
                    args = parseCallArgs(argsStr);
                }
            }
            else {
                args = parseCallArgs(argsStr);
            }

            results.push({ type: 'call', args: { name: syscallName, args } });
            continue;
        }

        // !stm (reserved)
        if (trimmed.startsWith('!stm')) {
            results.push({ type: 'stm', args: trimmed.slice(4).trim() });
            continue;
        }

        // !ltm (reserved)
        if (trimmed.startsWith('!ltm')) {
            results.push({ type: 'ltm', args: trimmed.slice(4).trim() });
            continue;
        }

        // !help
        if (trimmed === '!help' || trimmed.startsWith('!help ')) {
            results.push({ type: 'help', args: null });
            continue;
        }

        // !spawn "task" or !spawn {"task": "...", "model": "..."}
        // Also handles LLM confusion: !spawn spawn:xyz "task" (strips the spawn:id)
        const spawnMatch = trimmed.match(/^!spawn\s+(.+)/);
        if (spawnMatch && spawnMatch[1]) {
            let argStr = spawnMatch[1].trim();

            // Strip any spawn:id the LLM mistakenly added
            argStr = argStr.replace(/^spawn:[a-z0-9]+\s+/, '');

            let spawnArgs: { task: string; model?: string };

            // Try JSON object first
            if (argStr.startsWith('{')) {
                try {
                    spawnArgs = JSON.parse(argStr) as { task: string; model?: string };
                }
                catch {
                    // Fall back to quoted string
                    spawnArgs = { task: argStr.replace(/^["']|["']$/g, '') };
                }
            }
            else {
                // Quoted or plain string
                spawnArgs = { task: argStr.replace(/^["']|["']$/g, '') };
            }

            results.push({ type: 'spawn', args: spawnArgs });
            continue;
        }

        // !wait spawn:id OR !wait (waits for all)
        if (trimmed === '!wait') {
            results.push({ type: 'wait', args: 'all' });
            continue;
        }
        const waitMatch = trimmed.match(/^!wait\s+(spawn:[a-z0-9]+)/);
        if (waitMatch && waitMatch[1]) {
            results.push({ type: 'wait', args: waitMatch[1] });
            continue;
        }
    }

    return results.length > 0 ? results : null;
}

/**
 * Parse arguments for !call command.
 *
 * Tries to parse each space-separated token as JSON, falls back to string.
 * Handles quoted strings with spaces.
 */
function parseCallArgs(argsStr: string): unknown[] {
    if (!argsStr.trim()) return [];

    const args: unknown[] = [];
    let current = '';
    let inQuote: string | null = null;
    let escape = false;

    for (const char of argsStr) {
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
            current += char;
            continue;
        }

        if (char === inQuote) {
            inQuote = null;
            current += char;
            continue;
        }

        if (char === ' ' && !inQuote) {
            if (current) {
                args.push(parseArgValue(current));
                current = '';
            }
            continue;
        }

        current += char;
    }

    if (current) {
        args.push(parseArgValue(current));
    }

    return args;
}

/**
 * Parse a single argument value - try JSON first, fall back to string.
 */
function parseArgValue(value: string): unknown {
    // Try parsing as JSON (handles numbers, booleans, objects, arrays, quoted strings)
    try {
        return JSON.parse(value);
    }
    catch {
        // Not valid JSON, return as plain string
        return value;
    }
}

/**
 * Execute a !call syscall command.
 */
async function executeCall(name: string, args: unknown[]): Promise<string> {
    try {
        await eprintln(`prior: !call ${name} ${JSON.stringify(args)}`);

        const result = await call<unknown>(name, ...args);

        // Format result for LLM consumption
        if (result === undefined || result === null) {
            return '(no result)';
        }
        if (typeof result === 'string') {
            return result;
        }
        return JSON.stringify(result, null, 2);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return `Error: ${message}`;
    }
}

// =============================================================================
// TASK EXECUTION
// =============================================================================

/**
 * Execute a task using the LLM with agentic loop.
 *
 * The LLM can output exec([...]) calls to run shell commands.
 * Results are fed back to continue the conversation until
 * the LLM produces a final response without exec calls.
 */
async function executeTask(instruction: Instruction, skipLogging = false): Promise<TaskResult> {
    const startTime = Date.now();
    const model = instruction.model ?? DEFAULT_MODEL;

    // Conversation history for agentic loop
    const conversation: Array<{ role: 'user' | 'assistant' | 'exec'; content: string }> = [];

    // Build initial prompt with memory context
    const initialParts: string[] = [];

    if (identity) {
        initialParts.push(`My identity: ${identity}`);
    }

    if (memoryContext) {
        initialParts.push(`Memory context:\n${memoryContext}`);
    }

    if (instruction.context) {
        initialParts.push(`Task context:\n${JSON.stringify(instruction.context, null, 2)}`);
    }

    initialParts.push(`Task: ${instruction.task}`);

    conversation.push({ role: 'user', content: initialParts.join('\n\n') });

    try {
        let finalResponse = '';
        let iterations = 0;

        // Agentic loop: run until LLM produces response without exec() calls
        while (iterations < MAX_EXEC_ITERATIONS) {
            iterations++;

            // Build prompt from conversation history
            const prompt = conversation.map(turn => {
                if (turn.role === 'user') {
                    return `User: ${turn.content}`;
                }
                else if (turn.role === 'assistant') {
                    return `Assistant: ${turn.content}`;
                }
                else {
                    return `[Exec Result]:\n${turn.content}`;
                }
            }).join('\n\n');

            await eprintln(`prior: iteration ${iterations}, calling llm:complete with model=${model}`);

            const response = await call<CompletionResponse>('llm:complete', model, prompt, {
                system: systemPrompt,
            });

            await eprintln(`prior: llm responded, ${response.text.length} chars`);

            // Check for ! commands
            const bangCommands = parseBangCommands(response.text);

            if (!bangCommands || bangCommands.length === 0) {
                // No commands - this is the final response
                finalResponse = response.text;
                break;
            }

            // Execute all commands in parallel (multi-threaded)
            conversation.push({ role: 'assistant', content: response.text });

            const executeCommand = async (cmd: ParsedBangCommand): Promise<string> => {
                switch (cmd.type) {
                    case 'exec': {
                        const commands = cmd.args as string[];
                        await eprintln(`prior: !exec ${JSON.stringify(commands)}`);

                        const execResult = await exec(commands);
                        return execResult.code === 0
                            ? execResult.stdout || '(no output)'
                            : `Error (code ${execResult.code}): ${execResult.stderr || execResult.stdout || 'unknown error'}`;
                    }

                    case 'call': {
                        const { name, args } = cmd.args as { name: string; args: unknown[] };
                        return executeCall(name, args);
                    }

                    case 'stm':
                        return '[!stm not yet implemented]';

                    case 'ltm':
                        return '[!ltm not yet implemented]';

                    case 'help':
                        try {
                            return await readFile(HELP_PATH);
                        }
                        catch {
                            return 'Help file not found.';
                        }

                    case 'spawn': {
                        const spawnArgs = cmd.args as { task: string; model?: string };
                        const spawnId = generateSpawnId();
                        const spawnModel = spawnArgs.model ?? model;

                        await eprintln(`prior: !spawn ${spawnId} "${spawnArgs.task.slice(0, 50)}..."`);

                        // Create instruction for subagent (inherits context)
                        const subInstruction: Instruction = {
                            task: spawnArgs.task,
                            context: {
                                spawned_by: 'prior',
                                parent_identity: identity,
                            },
                            model: spawnModel,
                        };

                        // Start async execution, track in map
                        const promise = executeTask(subInstruction, true);
                        const agent: SpawnedAgent = {
                            id: spawnId,
                            task: spawnArgs.task,
                            model: spawnModel,
                            promise,
                            done: false,
                        };

                        // When promise resolves, mark done and store result
                        promise.then(result => {
                            agent.result = result;
                            agent.done = true;
                        });

                        spawnedAgents.set(spawnId, agent);
                        return spawnId;
                    }

                    case 'wait': {
                        const waitId = cmd.args as string;

                        // !wait (no id) - wait for all pending spawns
                        if (waitId === 'all') {
                            if (spawnedAgents.size === 0) {
                                return '(no pending spawns)';
                            }

                            await eprintln(`prior: !wait all (${spawnedAgents.size} pending...)`);

                            const results: string[] = [];
                            for (const [id, agent] of spawnedAgents) {
                                const result = await agent.promise;
                                const text = result.status === 'ok'
                                    ? result.result ?? '(no result)'
                                    : `Error: ${result.error ?? 'unknown error'}`;
                                results.push(`[${id}]: ${text}`);
                            }

                            spawnedAgents.clear();
                            return results.join('\n\n');
                        }

                        // !wait spawn:id - wait for specific spawn
                        const agent = spawnedAgents.get(waitId);

                        if (!agent) {
                            return `Error: unknown spawn id ${waitId}`;
                        }
                        else if (agent.done) {
                            const result = agent.result?.status === 'ok'
                                ? agent.result.result ?? '(no result)'
                                : `Error: ${agent.result?.error ?? 'unknown error'}`;
                            spawnedAgents.delete(waitId);
                            return result;
                        }
                        else {
                            // Wait for completion
                            await eprintln(`prior: !wait ${waitId} (blocking...)`);
                            const result = await agent.promise;
                            spawnedAgents.delete(waitId);
                            return result.status === 'ok'
                                ? result.result ?? '(no result)'
                                : `Error: ${result.error ?? 'unknown error'}`;
                        }
                    }

                    default:
                        return '[unknown command]';
                }
            };

            // Separate waits from other commands - waits must run after spawns
            const waitCommands = bangCommands.filter(cmd => cmd.type === 'wait');
            const otherCommands = bangCommands.filter(cmd => cmd.type !== 'wait');

            // Run non-wait commands in parallel
            const otherResults = await Promise.all(otherCommands.map(executeCommand));

            // Add those results to conversation
            for (const resultText of otherResults) {
                await eprintln(`prior: result: ${resultText.slice(0, 100)}${resultText.length > 100 ? '...' : ''}`);
                conversation.push({ role: 'exec', content: resultText });
            }

            // Now run waits (after spawns are registered)
            const waitResults = await Promise.all(waitCommands.map(executeCommand));

            for (const resultText of waitResults) {
                await eprintln(`prior: result: ${resultText.slice(0, 100)}${resultText.length > 100 ? '...' : ''}`);
                conversation.push({ role: 'exec', content: resultText });
            }
        }

        if (iterations >= MAX_EXEC_ITERATIONS) {
            finalResponse = `[Reached maximum iterations (${MAX_EXEC_ITERATIONS}). Last response may be incomplete.]`;
        }

        const result: TaskResult = {
            status: 'ok',
            result: finalResponse,
            model,
            duration_ms: Date.now() - startTime,
        };

        if (!skipLogging) {
            await logSession(instruction.task, finalResponse, 'ok');
        }

        return result;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`prior: error: ${message}`);

        const result: TaskResult = {
            status: 'error',
            error: message,
            duration_ms: Date.now() - startTime,
        };

        if (!skipLogging) {
            await logSession(instruction.task, message, 'error');
        }

        return result;
    }
}

// =============================================================================
// CONNECTION HANDLER
// =============================================================================

/**
 * HTTP request from channel.
 */
interface HttpRequest {
    method: string;
    path: string;
    query: Record<string, string>;
    headers: Record<string, string>;
    body: unknown;
}

/**
 * Handle a single client connection using HTTP channel.
 */
async function handleConnection(socketFd: number, from: string): Promise<void> {
    let channelFd: number | undefined;

    try {
        // Wrap socket in HTTP server channel
        channelFd = await call<number>('channel:accept', socketFd, 'http');

        // Receive HTTP request (parsed by channel)
        // channel:recv returns { op: 'request', data: HttpRequest }
        const recvResult = await call<{ op: string; data: HttpRequest }>('channel:recv', channelFd);
        const request = recvResult.data;

        await eprintln(`prior: ${request.method} ${request.path} from ${from}`);

        // Only accept POST to root
        if (request.method !== 'POST' || (request.path !== '/' && request.path !== '')) {
            await call<void>('channel:push', channelFd, {
                op: 'ok',
                data: {
                    status: 405,
                    body: { error: 'Method not allowed', message: 'Use POST /' },
                },
            });
            return;
        }

        // Parse instruction from body
        const body = request.body as Record<string, unknown> | null;

        if (!body || typeof body.task !== 'string') {
            await call<void>('channel:push', channelFd, {
                op: 'ok',
                data: {
                    status: 400,
                    body: { error: 'Bad request', message: 'Missing or invalid task field' },
                },
            });
            return;
        }

        const instruction: Instruction = {
            task: body.task,
            context: body.context as Record<string, unknown> | undefined,
            model: body.model as string | undefined,
        };

        await eprintln(`prior: received task from ${from}: ${instruction.task.slice(0, 50)}...`);

        // Execute task
        await eprintln(`prior: executing task...`);
        const result = await executeTask(instruction);
        await eprintln(`prior: task complete, sending response...`);

        // Send HTTP response
        await call<void>('channel:push', channelFd, {
            op: 'ok',
            data: {
                status: 200,
                body: result,
            },
        });

        await eprintln(`prior: completed task in ${result.duration_ms}ms`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`prior: connection error: ${message}`);

        // Try to send error response
        if (channelFd !== undefined) {
            try {
                await call<void>('channel:push', channelFd, {
                    op: 'ok',
                    data: {
                        status: 500,
                        body: { error: 'Internal error', message },
                    },
                });
            }
            catch {
                // Ignore write errors during error handling
            }
        }
    }
    finally {
        // Close channel (this also closes the underlying socket)
        if (channelFd !== undefined) {
            try {
                await call<void>('channel:close', channelFd);
            }
            catch {
                // Ignore close errors
            }
        }
    }
}

// =============================================================================
// MAIN
// =============================================================================

async function main(): Promise<void> {
    const pid = await getpid();

    await println(`prior: starting (pid ${pid})`);

    // Load system prompt
    try {
        systemPrompt = await readFile(SYSTEM_PROMPT_PATH);
        await eprintln(`prior: loaded system prompt (${systemPrompt.length} chars)`);
    }
    catch {
        await eprintln('prior: no system prompt found, running without');
    }

    // Initialize memory directory
    try {
        await mkdir(MEMORY_DIR, { recursive: true });
        await eprintln(`prior: memory directory ready at ${MEMORY_DIR}`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await eprintln(`prior: failed to create memory directory: ${message}`);
    }

    // Load existing identity if available
    try {
        identity = await readFile(IDENTITY_PATH);
        await eprintln(`prior: loaded existing identity (${identity.length} chars)`);
    }
    catch {
        // No identity yet - will be created on first tick
    }

    // Load existing context if available
    try {
        memoryContext = await readFile(CONTEXT_PATH);
        await eprintln(`prior: loaded memory context (${memoryContext.length} chars)`);
    }
    catch {
        // No context yet - will be created by distillation
    }

    // Subscribe to kernel ticks for autonomous behavior
    await subscribeTicks();
    await eprintln('prior: subscribed to kernel ticks');

    // Register tick handler
    onTick(async (dt, now, seq) => {
        // Skip if already processing a tick (prevent overlap)
        if (tickBusy) {
            return;
        }

        tickBusy = true;

        try {
            // First tick: self-discovery (only if no identity exists)
            if (seq === 1 && !identity) {
                await eprintln('prior: tick 1 - performing self-discovery');

                const result = await executeTask({
                    task: 'You just woke up. Describe your environment and capabilities based on your system knowledge. Be concise (2-3 sentences).',
                }, true);  // skipLogging - self-discovery is internal

                if (result.status === 'ok' && result.result) {
                    identity = result.result;
                    await eprintln(`prior: self-discovery complete`);
                    await eprintln(`prior: ${identity}`);

                    // Persist identity to file
                    try {
                        await writeFile(IDENTITY_PATH, identity);
                        await eprintln(`prior: identity saved to ${IDENTITY_PATH}`);
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        await eprintln(`prior: failed to save identity: ${msg}`);
                    }
                }
                else {
                    await eprintln(`prior: self-discovery failed: ${result.error}`);
                }
            }

            // Periodic heartbeat (every 60 ticks = ~60 seconds)
            if (seq % 60 === 0) {
                await eprintln(`prior: heartbeat tick=${seq} dt=${dt}ms`);
            }

            // Future: check for autonomous work queue, consolidate memory, etc.
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await eprintln(`prior: tick error: ${message}`);
        }
        finally {
            tickBusy = false;
        }
    });

    // Handle shutdown gracefully
    let running = true;

    onSignal(() => {
        running = false;
        eprintln('prior: received shutdown signal');
    });

    // Create TCP listener
    const port = DEFAULT_PORT;
    let listenerFd: number;

    try {
        listenerFd = await call<number>('port:create', 'tcp:listen', { port });
        await println(`prior: listening on tcp://0.0.0.0:${port}`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`prior: failed to bind port ${port}: ${message}`);
        return;
    }

    // Accept connections
    while (running) {
        try {
            // Accept next connection
            const msg = await call<{ from: string; fd: number }>('port:recv', listenerFd);

            if (!msg.fd) {
                await eprintln('prior: received connection without socket fd');
                continue;
            }

            await eprintln(`prior: connection from ${msg.from}`);

            // Handle connection (channel:accept consumes socket fd, handleConnection closes channel)
            await handleConnection(msg.fd, msg.from);
        }
        catch (err) {
            if (!running) {
                break;
            }

            const message = err instanceof Error ? err.message : String(err);

            await eprintln(`prior: accept error: ${message}`);
            await sleep(1000); // Back off on errors
        }
    }

    // Cleanup
    try {
        await call<void>('port:close', listenerFd);
    }
    catch {
        // Ignore close errors during shutdown
    }

    await println('prior: shutdown complete');
}

// Run
main().catch(async (err) => {
    await eprintln(`prior: fatal error: ${err}`);
});
