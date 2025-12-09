/**
 * Prior Session Logging - Audit trail and STM integration
 *
 * PURPOSE
 * =======
 * Logs task exchanges to a persistent session log and writes entries
 * to short-term memory (STM) for later consolidation into long-term
 * memory (LTM).
 *
 * LOG FORMAT
 * ==========
 * [timestamp] TASK: <truncated task>
 * [timestamp] OK|ERROR: <truncated result>
 *
 * STM SALIENCE
 * ============
 * - Errors: 7 (more notable, worth remembering)
 * - Successes: 5 (normal, may be consolidated)
 *
 * @module rom/lib/prior/session
 */

// =============================================================================
// IMPORTS
// =============================================================================

import { appendFile, call } from '@rom/lib/process/index.js';

import { SESSION_LOG_PATH } from './config.js';
import { log } from './logging.js';

// =============================================================================
// SESSION LOGGING
// =============================================================================

/**
 * Log a task exchange to the session log and STM.
 *
 * @param task - The task that was executed
 * @param result - The result or error message
 * @param status - Whether the task succeeded or failed
 */
export async function logSession(
    task: string,
    result: string,
    status: 'ok' | 'error'
): Promise<void> {
    const timestamp = new Date().toISOString();

    // Truncate for log readability
    const taskSummary = task.slice(0, 200) + (task.length > 200 ? '...' : '');
    const resultSummary = result.slice(0, 500) + (result.length > 500 ? '...' : '');

    const entry = `[${timestamp}] TASK: ${taskSummary}\n[${timestamp}] ${status.toUpperCase()}: ${resultSummary}\n\n`;

    // Write to session log file
    try {
        await appendFile(SESSION_LOG_PATH, entry);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await log(`prior: failed to log session: ${message}`);
    }

    // Write to short-term memory for later consolidation
    // WHY different salience: Errors are more notable and worth remembering
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
