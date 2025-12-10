/**
 * Prior Task Execution - Agentic loop for task processing
 *
 * PURPOSE
 * =======
 * Implements the core agentic loop for Prior. Tasks are executed by:
 * 1. Building a prompt from the instruction and context
 * 2. Sending to the LLM for completion
 * 3. Parsing any bang commands from the response
 * 4. Executing commands and feeding results back
 * 5. Repeating until no more commands or max iterations
 *
 * DESIGN
 * ======
 * The loop maintains a conversation history to provide context for
 * multi-turn interactions. Each LLM response is checked for bang
 * commands; if found, they're executed and results added to history.
 *
 * @module rom/lib/prior/task
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { call } from '@rom/lib/process/index.js';

import type {
    Instruction,
    TaskResult,
    CompletionResponse,
    ExecuteTaskOptions,
    ParsedBangCommand,
} from './types.js';
import { DEFAULT_MODEL, MAX_EXEC_ITERATIONS } from './config.js';
import { log, generateRequestId } from './logging.js';
import {
    getSystemPrompt,
    getIdentity,
    getMemoryContext,
    getEmsSchema,
} from './state.js';
import { logSession } from './session.js';
import {
    parseBangCommands,
    executeBangCommand,
    getBangCommandDescription,
    type BangExecutionContext,
} from './bang.js';

// =============================================================================
// CONVERSATION TYPES
// =============================================================================

/**
 * A turn in the conversation history.
 */
interface ConversationTurn {
    role: 'user' | 'assistant' | 'exec';
    content: string;
}

// =============================================================================
// TASK EXECUTION
// =============================================================================

/**
 * Execute a task using the LLM with agentic loop.
 *
 * The LLM can output bang commands to run shell commands, make syscalls,
 * spawn subagents, etc. Results are fed back to continue the conversation
 * until the LLM produces a final response without commands.
 *
 * @param instruction - The task to execute
 * @param options - Execution options
 * @param consolidateMemory - Function for memory consolidation (injected to avoid circular deps)
 * @returns Task result with status, result/error, timing, and request ID
 */
export async function executeTask(
    instruction: Instruction,
    options: ExecuteTaskOptions = {},
    consolidateMemory: () => Promise<void>,
): Promise<TaskResult> {
    const { skipLogging = false, clientAddr } = options;
    const startTime = Date.now();
    const model = instruction.model ?? DEFAULT_MODEL;
    const requestId = generateRequestId();

    // Create ai.request record
    try {
        await call('ems:create', 'ai.request', {
            id: requestId,
            task: instruction.task,
            client_addr: clientAddr,
            model,
            status: 'running',
            started_at: new Date().toISOString(),
        });
    }
    catch (err) {
        // Non-critical - log and continue
        const msg = err instanceof Error ? err.message : String(err);

        await log(`prior: failed to create ai.request: ${msg}`, requestId);
    }

    // Conversation history for agentic loop
    const conversation: ConversationTurn[] = [];

    // Event sequence counter (within each iteration)
    let eventSequence = 0;

    // Helper to record events
    const recordEvent = async (
        iteration: number,
        eventType: string,
        command: string,
        result: string,
        durationMs: number,
    ): Promise<void> => {
        try {
            await call('ems:create', 'ai.request_event', {
                request_id: requestId,
                iteration,
                sequence: eventSequence++,
                event_type: eventType,
                command,
                result: result.slice(0, 10000), // Truncate large results
                duration_ms: durationMs,
            });
        }
        catch {
            // Non-critical - don't fail the request
        }
    };

    // Build initial prompt with memory context
    const initialPrompt = buildInitialPrompt(instruction);

    conversation.push({ role: 'user', content: initialPrompt });

    // Create execution context for bang commands
    // WHY recursive reference: !spawn needs to call executeTask
    const ctx: BangExecutionContext = {
        executeTask: (instr, opts) => executeTask(instr, opts, consolidateMemory),
        consolidateMemory,
        currentModel: model,
        identity: getIdentity(),
    };

    try {
        let finalResponse = '';
        let iterations = 0;

        // Agentic loop: run until LLM produces response without bang commands
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
                system: getSystemPrompt(),
            });

            await log(`prior: llm responded, ${response.text.length} chars`);

            // Check for bang commands
            const bangCommands = parseBangCommands(response.text);

            if (!bangCommands || bangCommands.length === 0) {
                // No commands - this is the final response
                finalResponse = response.text;
                break;
            }

            // Execute all commands
            conversation.push({ role: 'assistant', content: response.text });

            // Reset sequence counter for each iteration
            eventSequence = 0;

            // Process commands in order, separating waits from others
            // WHY: Waits must run after spawns are registered
            const waitCommands = bangCommands.filter(cmd => cmd.type === 'wait');
            const otherCommands = bangCommands.filter(cmd => cmd.type !== 'wait');

            // Run non-wait commands in parallel
            const otherResults = await Promise.all(
                otherCommands.map(cmd => executeAndRecord(cmd, ctx, iterations, recordEvent)),
            );

            // Add those results to conversation
            for (let i = 0; i < otherResults.length; i++) {
                const resultText = otherResults[i];
                const cmd = getBangCommandDescription(otherCommands[i]!);

                await log(`prior: ${cmd} -> ${resultText.slice(0, 80)}${resultText.length > 80 ? '...' : ''}`);
                conversation.push({ role: 'exec', content: resultText });
            }

            // Now run waits (after spawns are registered)
            const waitResults = await Promise.all(
                waitCommands.map(cmd => executeAndRecord(cmd, ctx, iterations, recordEvent)),
            );

            for (let i = 0; i < waitResults.length; i++) {
                const resultText = waitResults[i];
                const cmd = getBangCommandDescription(waitCommands[i]!);

                await log(`prior: ${cmd} -> ${resultText.slice(0, 80)}${resultText.length > 80 ? '...' : ''}`);
                conversation.push({ role: 'exec', content: resultText });
            }
        }

        if (iterations >= MAX_EXEC_ITERATIONS) {
            finalResponse = `[Reached maximum iterations (${MAX_EXEC_ITERATIONS}). Last response may be incomplete.]`;
        }

        const durationMs = Date.now() - startTime;

        // Update ai.request record on success
        try {
            await call('ems:update', 'ai.request', requestId, {
                status: 'ok',
                result: finalResponse.slice(0, 10000), // Truncate large results
                iterations,
                completed_at: new Date().toISOString(),
                duration_ms: durationMs,
            });
        }
        catch {
            // Non-critical
        }

        const result: TaskResult = {
            status: 'ok',
            result: finalResponse,
            model,
            duration_ms: durationMs,
            request_id: requestId,
        };

        if (!skipLogging) {
            await logSession(instruction.task, finalResponse, 'ok');
        }

        return result;
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const durationMs = Date.now() - startTime;

        await log(`prior: error: ${message}`, requestId);

        // Update ai.request record on error
        try {
            await call('ems:update', 'ai.request', requestId, {
                status: 'error',
                result: message,
                completed_at: new Date().toISOString(),
                duration_ms: durationMs,
            });
        }
        catch {
            // Non-critical
        }

        const result: TaskResult = {
            status: 'error',
            error: message,
            duration_ms: durationMs,
            request_id: requestId,
        };

        if (!skipLogging) {
            await logSession(instruction.task, message, 'error');
        }

        return result;
    }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Build the initial prompt from instruction and context.
 */
function buildInitialPrompt(instruction: Instruction): string {
    const parts: string[] = [];

    const identity = getIdentity();

    if (identity) {
        parts.push(`My identity: ${identity}`);
    }

    const emsSchema = getEmsSchema();

    if (emsSchema) {
        parts.push(`EMS models (database tables):\n${emsSchema}`);
    }

    const memoryContext = getMemoryContext();

    if (memoryContext) {
        parts.push(`Memory context:\n${memoryContext}`);
    }

    if (instruction.context) {
        parts.push(`Task context:\n${JSON.stringify(instruction.context, null, 2)}`);
    }

    parts.push(`Task: ${instruction.task}`);

    return parts.join('\n\n');
}

/**
 * Execute a bang command and record the event.
 */
async function executeAndRecord(
    cmd: ParsedBangCommand,
    ctx: BangExecutionContext,
    iteration: number,
    recordEvent: (iteration: number, eventType: string, command: string, result: string, durationMs: number) => Promise<void>,
): Promise<string> {
    const cmdStart = Date.now();
    const result = await executeBangCommand(cmd, ctx);
    const cmdString = getBangCommandDescription(cmd);

    await recordEvent(iteration, cmd.type, cmdString, result, Date.now() - cmdStart);

    return result;
}
