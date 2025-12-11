/**
 * AI App Bang Commands - Parser and executor for ! commands
 *
 * PURPOSE
 * =======
 * Parses and executes "bang commands" from LLM output. These commands
 * allow the LLM to interact with the system, execute shell commands,
 * make syscalls, and manage spawned subagents.
 *
 * SUPPORTED COMMANDS
 * ==================
 * !exec <shell command>              - Execute shell command
 * !call syscall:name arg1 arg2 ...   - Direct syscall
 * !ref keyword1 keyword2 ...         - Search memories
 * !coalesce                          - Force memory consolidation
 * !spawn "task" | {task, model}      - Spawn subagent
 * !wait [spawn:id]                   - Wait for subagent(s)
 * !ems <subcommand> [args]           - EMS operations
 * !help                              - Show help
 * !stm / !ltm                        - Memory operations (reserved)
 *
 * @module rom/app/ai/lib/bang
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { call, readFile } from '@rom/lib/process/index.js';

import type {
    ParsedBangCommand,
    SpawnArgs,
    EmsArgs,
    CallArgs,
    TaskResult,
    StmEntry,
    LtmEntry,
} from './types.js';
import { HELP_PATH } from './config.js';
import { log, generateSpawnId, debugBang } from './logging.js';
import {
    getSpawnedAgent,
    setSpawnedAgent,
    deleteSpawnedAgent,
    getAllSpawnedAgents,
    clearSpawnedAgents,
} from './state.js';
import { exec, executeCall } from './exec.js';

// =============================================================================
// COMMAND PARSING
// =============================================================================

/**
 * Parse ! commands from LLM response.
 *
 * @param text - LLM response text
 * @returns Array of parsed commands, or null if none found
 */
export function parseBangCommands(text: string): ParsedBangCommand[] | null {
    const results: ParsedBangCommand[] = [];
    const lines = text.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        const parsed = parseLine(trimmed);

        if (parsed) {
            results.push(parsed);
        }
    }

    return results.length > 0 ? results : null;
}

/**
 * Parse a single line for a bang command.
 */
function parseLine(trimmed: string): ParsedBangCommand | null {
    // !exec <shell command> - everything after !exec is passed to shell
    if (trimmed.startsWith('!exec ')) {
        const shellCmd = trimmed.slice(6).trim();

        if (shellCmd) {
            return { type: 'exec', args: shellCmd };
        }

        return null;
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

        return { type: 'call', args: { name: syscallName, args } as CallArgs };
    }

    // !ref keyword1 keyword2 ... - search memories
    if (trimmed.startsWith('!ref ')) {
        const keywords = trimmed.slice(5).trim();

        if (keywords) {
            return { type: 'ref', args: keywords };
        }

        return null;
    }

    // !coalesce - force memory consolidation
    if (trimmed === '!coalesce') {
        return { type: 'coalesce', args: null };
    }

    // !stm (reserved)
    if (trimmed.startsWith('!stm')) {
        return { type: 'stm', args: trimmed.slice(4).trim() };
    }

    // !ltm (reserved)
    if (trimmed.startsWith('!ltm')) {
        return { type: 'ltm', args: trimmed.slice(4).trim() };
    }

    // !help
    if (trimmed === '!help' || trimmed.startsWith('!help ')) {
        return { type: 'help', args: null };
    }

    // !spawn "task" or !spawn {"task": "...", "model": "..."}
    // Also handles LLM confusion: !spawn spawn:xyz "task" (strips the spawn:id)
    const spawnMatch = trimmed.match(/^!spawn\s+(.+)/);

    if (spawnMatch && spawnMatch[1]) {
        let argStr = spawnMatch[1].trim();

        // Strip any spawn:id the LLM mistakenly added
        argStr = argStr.replace(/^spawn:[a-z0-9]+\s+/, '');

        let spawnArgs: SpawnArgs;

        // Try JSON object first
        if (argStr.startsWith('{')) {
            try {
                spawnArgs = JSON.parse(argStr) as SpawnArgs;
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

        return { type: 'spawn', args: spawnArgs };
    }

    // !wait spawn:id OR !wait (waits for all)
    if (trimmed === '!wait') {
        return { type: 'wait', args: 'all' };
    }

    const waitMatch = trimmed.match(/^!wait\s+(spawn:[a-z0-9]+)/);

    if (waitMatch && waitMatch[1]) {
        return { type: 'wait', args: waitMatch[1] };
    }

    // !ems <subcommand> [args...]
    const emsMatch = trimmed.match(/^!ems\s+(\S+)(?:\s+(.*))?/);

    if (emsMatch && emsMatch[1]) {
        const subcommand = emsMatch[1].toLowerCase();
        const emsArgs = (emsMatch[2] || '').trim();

        return { type: 'ems', args: { subcommand, args: emsArgs } as EmsArgs };
    }

    return null;
}

/**
 * Parse arguments for !call command.
 *
 * Tries to parse each space-separated token as JSON, falls back to string.
 * Handles quoted strings with spaces.
 */
export function parseCallArgs(argsStr: string): unknown[] {
    if (!argsStr.trim()) {
        return [];
    }

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

// =============================================================================
// COMMAND EXECUTION
// =============================================================================

/**
 * Options for bang command execution.
 */
export interface BangExecutionContext {
    /** Function to execute tasks (for !spawn) */
    executeTask: (instruction: { task: string; context?: Record<string, unknown>; model?: string }, options?: { skipLogging?: boolean }) => Promise<TaskResult>;
    /** Function to consolidate memory (for !coalesce) */
    consolidateMemory: () => Promise<void>;
    /** Current model being used */
    currentModel: string;
    /** Current identity */
    identity?: string;
}

/**
 * Execute a single bang command.
 *
 * @param cmd - The parsed command
 * @param ctx - Execution context
 * @returns Result string for the LLM
 */
export async function executeBangCommand(
    cmd: ParsedBangCommand,
    ctx: BangExecutionContext,
): Promise<string> {
    debugBang('executing %s', getBangCommandDescription(cmd));

    switch (cmd.type) {
        case 'exec': {
            const shellCmd = cmd.args as string;

            debugBang('exec: %s', shellCmd.slice(0, 80));
            const execResult = await exec(shellCmd);

            debugBang('exec result: code=%d stdout=%d chars', execResult.code, execResult.stdout.length);

            return execResult.code === 0
                ? execResult.stdout || '(no output)'
                : `Error (code ${execResult.code}): ${execResult.stderr || execResult.stdout || 'unknown error'}`;
        }

        case 'call': {
            const { name, args } = cmd.args as CallArgs;

            debugBang('call: %s with %d args', name, args.length);

            return await executeCall(name, args);
        }

        case 'ref':
            return await executeRef(cmd.args as string);

        case 'coalesce':
            await ctx.consolidateMemory();

            return 'Memory consolidation complete.';

        case 'stm':
            return '[!stm not yet implemented]';

        case 'ltm':
            return '[!ltm not yet implemented]';

        case 'help':
            return await executeHelp();

        case 'spawn':
            return await executeSpawn(cmd.args as SpawnArgs, ctx);

        case 'wait':
            return await executeWait(cmd.args as string);

        case 'ems':
            return await executeEms(cmd.args as EmsArgs);

        default:
            return '[unknown command]';
    }
}

/**
 * Execute !ref command - search memories.
 */
async function executeRef(keywordsStr: string): Promise<string> {
    const keywords = keywordsStr.toLowerCase().split(/\s+/);
    const refResults: string[] = [];

    // Search LTM (prioritized - these are consolidated insights)
    try {
        const ltmEntries = await call<LtmEntry[]>(
            'ems:select',
            'ai.ltm',
            { orderBy: ['-reinforced', '-created_at'], limit: 50 },
        );

        // Simple keyword matching
        const ltmMatches = ltmEntries.filter(e => {
            const text = e.content.toLowerCase();

            return keywords.some(kw => text.includes(kw));
        }).slice(0, 5);

        for (const m of ltmMatches) {
            refResults.push(`[LTM/${m.category}] ${m.content}`);
        }
    }
    catch {
        // LTM query failed, continue
    }

    // Search STM (recent experiences)
    try {
        const stmEntries = await call<StmEntry[]>(
            'ems:select',
            'ai.stm',
            {
                where: { consolidated: 0 },
                orderBy: ['-salience', '-created_at'],
                limit: 30,
            },
        );

        const stmMatches = stmEntries.filter(e => {
            const text = e.content.toLowerCase();

            return keywords.some(kw => text.includes(kw));
        }).slice(0, 3);

        for (const m of stmMatches) {
            refResults.push(`[STM] ${m.content.slice(0, 200)}`);
        }
    }
    catch {
        // STM query failed, continue
    }

    return refResults.length === 0
        ? '(no matching memories)'
        : `Relevant memories:\n${refResults.join('\n\n')}`;
}

/**
 * Execute !help command.
 */
async function executeHelp(): Promise<string> {
    try {
        return await readFile(HELP_PATH);
    }
    catch {
        return 'Help file not found.';
    }
}

/**
 * Execute !spawn command - spawn a subagent.
 */
async function executeSpawn(spawnArgs: SpawnArgs, ctx: BangExecutionContext): Promise<string> {
    const spawnId = generateSpawnId();
    const spawnModel = spawnArgs.model ?? ctx.currentModel;

    debugBang('spawn: %s model=%s task=%s', spawnId, spawnModel, spawnArgs.task.slice(0, 50));

    // Create instruction for subagent (inherits context)
    const subInstruction = {
        task: spawnArgs.task,
        context: {
            spawned_by: 'prior',
            parent_identity: ctx.identity,
        },
        model: spawnModel,
    };

    // Start async execution, track in state
    const promise = ctx.executeTask(subInstruction, { skipLogging: true });

    const agent: {
        id: string;
        task: string;
        model: string;
        promise: Promise<TaskResult>;
        done: boolean;
        result?: TaskResult;
    } = {
        id: spawnId,
        task: spawnArgs.task,
        model: spawnModel,
        promise,
        done: false,
    };

    // When promise resolves, mark done and store result
    promise.then(spawnResult => {
        agent.result = spawnResult;
        agent.done = true;
    });

    setSpawnedAgent(spawnId, agent);

    return spawnId;
}

/**
 * Execute !wait command - wait for subagent(s).
 */
async function executeWait(waitId: string): Promise<string> {
    // !wait (no id) - wait for all pending spawns
    if (waitId === 'all') {
        const agents = getAllSpawnedAgents();

        if (agents.size === 0) {
            debugBang('wait all: no pending spawns');

            return '(no pending spawns)';
        }

        debugBang('wait all: %d pending spawns', agents.size);

        const waitResults: string[] = [];

        for (const [id, agent] of agents) {
            const agentResult = await agent.promise;
            const text = agentResult.status === 'ok'
                ? agentResult.result ?? '(no result)'
                : `Error: ${agentResult.error ?? 'unknown error'}`;

            waitResults.push(`[${id}]: ${text}`);
        }

        clearSpawnedAgents();

        return waitResults.join('\n\n');
    }

    // !wait spawn:id - wait for specific spawn
    const agent = getSpawnedAgent(waitId);

    if (!agent) {
        return `Error: unknown spawn id ${waitId}`;
    }

    if (agent.done) {
        const result = agent.result?.status === 'ok'
            ? agent.result.result ?? '(no result)'
            : `Error: ${agent.result?.error ?? 'unknown error'}`;

        deleteSpawnedAgent(waitId);

        return result;
    }

    // Wait for completion
    debugBang('wait %s: blocking...', waitId);
    const agentResult = await agent.promise;
    debugBang('wait %s: completed', waitId);

    deleteSpawnedAgent(waitId);

    return agentResult.status === 'ok'
        ? agentResult.result ?? '(no result)'
        : `Error: ${agentResult.error ?? 'unknown error'}`;
}

/**
 * Execute !ems command - EMS operations via shell.
 */
async function executeEms(emsCmd: EmsArgs): Promise<string> {
    const { subcommand, args } = emsCmd;

    // Map subcommands to shell commands
    let shellCommand: string;

    switch (subcommand) {
        case 'describe':
            shellCommand = args ? `describe ${args}` : 'describe';
            break;
        case 'select':
        case 'list':
        case 'query':
            shellCommand = args ? `select ${args}` : 'select';
            break;
        case 'create':
            shellCommand = args ? `create ${args}` : 'create';
            break;
        case 'update':
            shellCommand = args ? `update ${args}` : 'update';
            break;
        case 'delete':
            shellCommand = args ? `delete ${args}` : 'delete';
            break;
        case 'revert':
            shellCommand = args ? `revert ${args}` : 'revert';
            break;
        case 'expire':
            shellCommand = args ? `expire ${args}` : 'expire';
            break;
        default:
            return `Error: unknown ems subcommand: ${subcommand}. Use: describe, select, create, update, delete, revert, expire`;
    }

    const execResult = await exec(shellCommand);

    return execResult.code === 0
        ? execResult.stdout || '(no output)'
        : `Error (code ${execResult.code}): ${execResult.stderr || execResult.stdout || 'unknown error'}`;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Get a short description of a bang command for logging.
 */
export function getBangCommandDescription(cmd: ParsedBangCommand): string {
    switch (cmd.type) {
        case 'exec':
            return `!exec ${(cmd.args as string).slice(0, 40)}`;
        case 'call': {
            const { name } = cmd.args as CallArgs;

            return `!call ${name}`;
        }

        case 'spawn':
            return '!spawn';
        case 'wait':
            return '!wait';
        case 'ref':
            return `!ref ${cmd.args}`;
        case 'coalesce':
            return '!coalesce';
        case 'help':
            return '!help';
        case 'ems': {
            const { subcommand, args } = cmd.args as EmsArgs;

            return `!ems ${subcommand} ${args}`.trim().slice(0, 50);
        }

        default:
            return `!${cmd.type}`;
    }
}
