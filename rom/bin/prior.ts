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
    debug,
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
} from '@rom/lib/process/index.js';
import type { Response } from '@rom/lib/process/types.js';

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
// LOGGING
// =============================================================================

/**
 * Log a message to both stderr and the UDP monitor.
 */
async function log(message: string): Promise<void> {
    await eprintln(message);
    await debug(message);
}

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
        await log(`prior: failed to log session: ${message}`);
    }

    // Write to short-term memory for later consolidation
    // Salience: errors are more notable (7), successes are normal (5)
    try {
        await call('ems:create', 'ai.stm', {
            content: `Task: ${task.slice(0, 500)}\nResult (${status}): ${result.slice(0, 1000)}`,
            context: JSON.stringify({ source: 'task', status }),
            salience: status === 'error' ? 7 : 5,
        });
    }
    catch {
        // STM write is non-critical, don't fail the task
    }
}

// =============================================================================
// COMMAND EXECUTION
// =============================================================================

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
 * Execute a shell command and capture output.
 *
 * Routes command through /bin/shell.ts for full shell support:
 * - Pipes (|)
 * - Redirects (>, >>)
 * - Chaining (&&, ||, ;)
 * - Globs (*, ?)
 * - Variable expansion ($VAR)
 *
 * @param shellCmd - Shell command string (passed directly to shell -c)
 * @returns Execution result with stdout, stderr, and exit code
 */
async function exec(shellCmd: string): Promise<ExecResult> {
    if (!shellCmd.trim()) {
        return { stdout: '', stderr: '', code: 0 };
    }

    const cwd = await getcwd();

    // Create pipe to capture output
    const [outputReadFd, outputWriteFd] = await pipe();

    try {
        // Spawn shell with -c to execute command
        const pid = await spawn('/bin/shell.ts', {
            args: ['shell', '-c', shellCmd],
            cwd,
            stdout: outputWriteFd,
        });

        // Close write end in parent so we see EOF when shell exits
        await close(outputWriteFd);

        // Read output
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

        // Wait for shell to complete
        const status = await wait(pid);

        // Close read end
        await close(outputReadFd).catch(() => {});

        return {
            stdout: outputChunks.join(''),
            stderr: '',
            code: status.code,
        };
    }
    catch (err) {
        await close(outputReadFd).catch(() => {});
        await close(outputWriteFd).catch(() => {});

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
 *   !exec <shell command>                  # shell command (passed directly to shell)
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

        // !exec <shell command> - everything after !exec is passed to shell
        if (trimmed.startsWith('!exec ')) {
            const shellCmd = trimmed.slice(6).trim();
            if (shellCmd) {
                results.push({ type: 'exec', args: shellCmd });
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

        // !ref keyword1 keyword2 ... - search memories
        if (trimmed.startsWith('!ref ')) {
            const keywords = trimmed.slice(5).trim();
            if (keywords) {
                results.push({ type: 'ref', args: keywords });
            }
            continue;
        }

        // !coalesce - force memory consolidation
        if (trimmed === '!coalesce') {
            results.push({ type: 'coalesce', args: null });
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
        await log(`prior: !call ${name} ${JSON.stringify(args)}`);

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

            await log(`prior: iteration ${iterations}, calling llm:complete with model=${model}`);

            const response = await call<CompletionResponse>('llm:complete', model, prompt, {
                system: systemPrompt,
            });

            await log(`prior: llm responded, ${response.text.length} chars`);

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
                        const shellCmd = cmd.args as string;
                        await log(`prior: !exec ${shellCmd}`);

                        const execResult = await exec(shellCmd);
                        return execResult.code === 0
                            ? execResult.stdout || '(no output)'
                            : `Error (code ${execResult.code}): ${execResult.stderr || execResult.stdout || 'unknown error'}`;
                    }

                    case 'call': {
                        const { name, args } = cmd.args as { name: string; args: unknown[] };
                        return executeCall(name, args);
                    }

                    case 'ref': {
                        const keywords = (cmd.args as string).toLowerCase().split(/\s+/);
                        await log(`prior: !ref searching for: ${keywords.join(', ')}`);

                        const results: string[] = [];

                        // Search LTM (prioritized - these are consolidated insights)
                        try {
                            const ltmEntries = await call<Array<{
                                id: string;
                                content: string;
                                category: string;
                                reinforced: number;
                            }>>(
                                'ems:select',
                                'ai.ltm',
                                { orderBy: ['-reinforced', '-created_at'], limit: 50 }
                            );

                            // Simple keyword matching
                            const ltmMatches = ltmEntries.filter(e => {
                                const text = e.content.toLowerCase();
                                return keywords.some(kw => text.includes(kw));
                            }).slice(0, 5);

                            for (const m of ltmMatches) {
                                results.push(`[LTM/${m.category}] ${m.content}`);
                            }
                        }
                        catch {
                            // LTM query failed, continue
                        }

                        // Search STM (recent experiences)
                        try {
                            const stmEntries = await call<Array<{
                                id: string;
                                content: string;
                                salience: number;
                            }>>(
                                'ems:select',
                                'ai.stm',
                                {
                                    where: { consolidated: 0 },
                                    orderBy: ['-salience', '-created_at'],
                                    limit: 30,
                                }
                            );

                            const stmMatches = stmEntries.filter(e => {
                                const text = e.content.toLowerCase();
                                return keywords.some(kw => text.includes(kw));
                            }).slice(0, 3);

                            for (const m of stmMatches) {
                                results.push(`[STM] ${m.content.slice(0, 200)}`);
                            }
                        }
                        catch {
                            // STM query failed, continue
                        }

                        if (results.length === 0) {
                            return '(no matching memories)';
                        }

                        return `Relevant memories:\n${results.join('\n\n')}`;
                    }

                    case 'coalesce': {
                        await consolidateMemory();
                        return 'Memory consolidation complete.';
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

                        await log(`prior: !spawn ${spawnId} "${spawnArgs.task.slice(0, 50)}..."`);

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

                            await log(`prior: !wait all (${spawnedAgents.size} pending...)`);

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
                            await log(`prior: !wait ${waitId} (blocking...)`);
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
                await log(`prior: result: ${resultText.slice(0, 100)}${resultText.length > 100 ? '...' : ''}`);
                conversation.push({ role: 'exec', content: resultText });
            }

            // Now run waits (after spawns are registered)
            const waitResults = await Promise.all(waitCommands.map(executeCommand));

            for (const resultText of waitResults) {
                await log(`prior: result: ${resultText.slice(0, 100)}${resultText.length > 100 ? '...' : ''}`);
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

        await log(`prior: error: ${message}`);

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
 * Consolidate short-term memories into long-term storage.
 * Runs periodically during idle ticks (every ~10 minutes).
 */
async function consolidateMemory(): Promise<void> {
    await log('prior: starting memory consolidation');

    try {
        // Find unconsolidated STM entries, ordered by salience
        const stmEntries = await call<Array<{ id: string; content: string; context: string; salience: number }>>(
            'ems:select',
            'ai.stm',
            {
                where: { consolidated: 0 },
                orderBy: ['-salience', 'created_at'],
                limit: 20,
            }
        );

        if (stmEntries.length === 0) {
            await log('prior: no memories to consolidate');
            return;
        }

        await log(`prior: consolidating ${stmEntries.length} memories`);

        // Build context for LLM
        const memoryList = stmEntries
            .map((m, i) => `[${i + 1}] (salience=${m.salience}) ${m.content}`)
            .join('\n');

        const result = await executeTask({
            task: `Review these recent memories and extract lasting insights worth remembering long-term. For each insight, output a JSON object on its own line with format: {"content": "...", "category": "..."}

Categories: user_prefs, project_facts, lessons, patterns, corrections

Memories to review:
${memoryList}

Output only JSON lines, no commentary. If nothing is worth keeping, output nothing.`,
        }, true);

        if (result.status === 'ok' && result.result) {
            // Parse JSON lines from response
            const lines = result.result.split('\n').filter((l: string) => l.trim().startsWith('{'));

            for (const line of lines) {
                try {
                    const insight = JSON.parse(line) as { content: string; category: string };

                    // Create LTM entry
                    await call('ems:create', 'ai.ltm', {
                        content: insight.content,
                        category: insight.category,
                        source_ids: JSON.stringify(stmEntries.map(e => e.id)),
                        last_accessed: new Date().toISOString(),
                    });

                    await log(`prior: stored insight [${insight.category}]: ${insight.content.slice(0, 50)}...`);
                }
                catch {
                    // Skip malformed lines
                }
            }
        }

        // Mark all processed STM entries as consolidated
        const now = new Date().toISOString();

        for (const entry of stmEntries) {
            await call('ems:update', 'ai.stm', entry.id, {
                consolidated: 1,
                consolidated_at: now,
            });
        }

        await log('prior: memory consolidation complete');
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await log(`prior: consolidation error: ${message}`);
    }
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

        await log(`prior: ${request.method} ${request.path} from ${from}`);

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

        await log(`prior: received task from ${from}: ${instruction.task.slice(0, 50)}...`);

        // Execute task
        await log(`prior: executing task...`);
        const result = await executeTask(instruction);
        await log(`prior: task complete, sending response...`);

        // Send HTTP response
        await call<void>('channel:push', channelFd, {
            op: 'ok',
            data: {
                status: 200,
                body: result,
            },
        });

        await log(`prior: completed task in ${result.duration_ms}ms`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await log(`prior: connection error: ${message}`);

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

    await log(`prior: starting (pid ${pid})`);

    // Load system prompt
    try {
        systemPrompt = await readFile(SYSTEM_PROMPT_PATH);
        await log(`prior: loaded system prompt (${systemPrompt.length} chars)`);
    }
    catch {
        await log('prior: no system prompt found, running without');
    }

    // Initialize memory directory
    try {
        await mkdir(MEMORY_DIR, { recursive: true });
        await log(`prior: memory directory ready at ${MEMORY_DIR}`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await log(`prior: failed to create memory directory: ${message}`);
    }

    // Load existing identity if available
    try {
        identity = await readFile(IDENTITY_PATH);
        await log(`prior: loaded existing identity (${identity.length} chars)`);
    }
    catch {
        // No identity yet - will be created on first tick
    }

    // Load existing context if available
    try {
        memoryContext = await readFile(CONTEXT_PATH);
        await log(`prior: loaded memory context (${memoryContext.length} chars)`);
    }
    catch {
        // No context yet - will be created by distillation
    }

    // Subscribe to kernel ticks for autonomous behavior
    await subscribeTicks();
    await log('prior: subscribed to kernel ticks');

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
                await log('prior: tick 1 - performing self-discovery');

                const result = await executeTask({
                    task: 'You just woke up. Describe your environment and capabilities based on your system knowledge. Be concise (2-3 sentences).',
                }, true);  // skipLogging - self-discovery is internal

                if (result.status === 'ok' && result.result) {
                    identity = result.result;
                    await log(`prior: self-discovery complete`);
                    await log(`prior: ${identity}`);

                    // Persist identity to file
                    try {
                        await writeFile(IDENTITY_PATH, identity);
                        await log(`prior: identity saved to ${IDENTITY_PATH}`);
                    }
                    catch (err) {
                        const msg = err instanceof Error ? err.message : String(err);
                        await log(`prior: failed to save identity: ${msg}`);
                    }
                }
                else {
                    await log(`prior: self-discovery failed: ${result.error}`);
                }
            }

            // Periodic heartbeat (every 60 ticks = ~60 seconds)
            if (seq % 60 === 0) {
                await log(`prior: heartbeat tick=${seq} dt=${dt}ms`);
            }

            // Memory consolidation (every 600 ticks = ~10 minutes)
            if (seq % 600 === 0) {
                await consolidateMemory();
            }
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            await log(`prior: tick error: ${message}`);
        }
        finally {
            tickBusy = false;
        }
    });

    // Handle shutdown gracefully
    let running = true;

    onSignal(() => {
        running = false;
        log('prior: received shutdown signal');
    });

    // Create TCP listener
    const port = DEFAULT_PORT;
    let listenerFd: number;

    try {
        listenerFd = await call<number>('port:create', 'tcp:listen', { port });
        await log(`prior: listening on tcp://0.0.0.0:${port}`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await log(`prior: failed to bind port ${port}: ${message}`);
        return;
    }

    // Accept connections
    while (running) {
        try {
            // Accept next connection
            const msg = await call<{ from: string; fd: number }>('port:recv', listenerFd);

            if (!msg.fd) {
                await log('prior: received connection without socket fd');
                continue;
            }

            await log(`prior: connection from ${msg.from}`);

            // Handle connection (channel:accept consumes socket fd, handleConnection closes channel)
            await handleConnection(msg.fd, msg.from);
        }
        catch (err) {
            if (!running) {
                break;
            }

            const message = err instanceof Error ? err.message : String(err);

            await log(`prior: accept error: ${message}`);
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

    await log('prior: shutdown complete');
}

// Run
main().catch(async (err) => {
    await log(`prior: fatal error: ${err}`);
});
