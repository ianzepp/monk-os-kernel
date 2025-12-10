/**
 * agentd - Agent Daemon
 *
 * Scheduled AI task execution using EMS-backed agent entities.
 * Combines crond's scheduling with Prior's AI capabilities.
 *
 * Agents are stored as 'agent' entities and can be managed via:
 *   ems:create agent { name, prompt, schedule, model }
 *   ems:update agent <id> { enabled: false }
 *   ems:select agent { enabled: true }
 *   ems:delete agent <id>
 *
 * Examples:
 *
 *   // Short-term memory consolidation (every 10 minutes)
 *   ems:create agent {
 *       name: "memory-short",
 *       prompt: "Review the last 10 minutes of activity. Extract key facts.",
 *       schedule: "*\/10 * * * *",
 *       model: "haiku"
 *   }
 *
 *   // Daily summary (every evening at 6pm)
 *   ems:create agent {
 *       name: "daily-summary",
 *       prompt: "Summarize today's key events and decisions.",
 *       schedule: "0 18 * * *",
 *       model: "sonnet"
 *   }
 *
 *   // Health check (every hour)
 *   ems:create agent {
 *       name: "health-check",
 *       prompt: "Review system state. Flag any anomalies or concerns.",
 *       schedule: "0 * * * *",
 *       model: "haiku"
 *   }
 */

import {
    call,
    collect,
    getpid,
    println,
    eprintln,
    onSignal,
    onTick,
    subscribeTicks,
} from '@rom/lib/process/index.js';

// =============================================================================
// TYPES
// =============================================================================

interface Agent {
    id: string;
    name: string;
    prompt: string;
    schedule: string;
    model: string;
    context: Record<string, unknown> | null;
    system_prompt: string | null;
    enabled: boolean;
    next_run: string | null;
    last_run: string | null;
    last_result: string | null;
    last_error: string | null;
    run_count: number;
    fail_count: number;
    timeout: number | null;
    max_tokens: number | null;
}

interface AiTaskRequest {
    task: string;
    context?: Record<string, unknown>;
    model?: string;
    system_prompt?: string;
    max_tokens?: number;
}

interface AiTaskResponse {
    status: 'ok' | 'error';
    result?: string;
    error?: string;
}

// =============================================================================
// CRON PARSING (shared with crond)
// =============================================================================

/**
 * Parse a cron field into a set of valid values.
 */
function parseField(field: string, min: number, max: number): Set<number> {
    const values = new Set<number>();

    for (const part of field.split(',')) {
        if (part === '*') {
            for (let i = min; i <= max; i++) {
                values.add(i);
            }
        }
        else if (part.includes('/')) {
            const splitParts = part.split('/');
            const range = splitParts[0] ?? '*';
            const stepStr = splitParts[1] ?? '1';
            const step = parseInt(stepStr, 10);
            const start = range === '*' ? min : parseInt(range, 10);

            for (let i = start; i <= max; i += step) {
                values.add(i);
            }
        }
        else if (part.includes('-')) {
            const splitParts = part.split('-');
            const start = parseInt(splitParts[0] ?? '0', 10);
            const end = parseInt(splitParts[1] ?? '0', 10);

            for (let i = start; i <= end; i++) {
                values.add(i);
            }
        }
        else {
            values.add(parseInt(part, 10));
        }
    }

    return values;
}

/**
 * Check if a cron spec matches the given date.
 */
function matchesCron(spec: string, date: Date): boolean {
    const parts = spec.trim().split(/\s+/);

    if (parts.length !== 5) {
        return false;
    }

    const minuteSpec = parts[0] ?? '*';
    const hourSpec = parts[1] ?? '*';
    const daySpec = parts[2] ?? '*';
    const monthSpec = parts[3] ?? '*';
    const dowSpec = parts[4] ?? '*';

    const minute = date.getMinutes();
    const hour = date.getHours();
    const day = date.getDate();
    const month = date.getMonth() + 1;
    const dow = date.getDay();

    return (
        parseField(minuteSpec, 0, 59).has(minute) &&
        parseField(hourSpec, 0, 23).has(hour) &&
        parseField(daySpec, 1, 31).has(day) &&
        parseField(monthSpec, 1, 12).has(month) &&
        parseField(dowSpec, 0, 6).has(dow)
    );
}

/**
 * Calculate the next run time for a cron spec.
 */
function getNextRun(spec: string, after: Date = new Date()): Date {
    const next = new Date(after);

    next.setSeconds(0);
    next.setMilliseconds(0);
    next.setMinutes(next.getMinutes() + 1);

    // Search up to 1 year ahead
    const limit = new Date(after);

    limit.setFullYear(limit.getFullYear() + 1);

    while (next < limit) {
        if (matchesCron(spec, next)) {
            return next;
        }

        next.setMinutes(next.getMinutes() + 1);
    }

    // Fallback: 1 year from now
    return limit;
}

// =============================================================================
// AGENT EXECUTION
// =============================================================================

/**
 * Execute an agent's AI task.
 */
async function executeAgent(agent: Agent): Promise<void> {
    await println(`agentd: running agent '${agent.name}'`);

    const startTime = new Date().toISOString();
    let result: string | null = null;
    let error: string | null = null;

    try {
        // Build AI task request
        const request: AiTaskRequest = {
            task: agent.prompt,
            model: agent.model,
        };

        if (agent.context) {
            request.context = agent.context;
        }

        if (agent.system_prompt) {
            request.system_prompt = agent.system_prompt;
        }

        if (agent.max_tokens) {
            request.max_tokens = agent.max_tokens;
        }

        // Call Prior via ai:task syscall
        const response = await call<AiTaskResponse>('ai:task', request);

        if (response.status === 'ok') {
            result = response.result ?? null;
        }
        else {
            error = response.error ?? 'Unknown error';
        }
    }
    catch (err) {
        error = err instanceof Error ? err.message : String(err);
        await eprintln(`agentd: agent '${agent.name}' failed: ${error}`);
    }

    // Calculate next run time
    const nextRun = getNextRun(agent.schedule);

    // Update agent status
    try {
        await call('ems:update', 'agent', agent.id, {
            last_run: startTime,
            last_result: result,
            last_error: error,
            next_run: nextRun.toISOString(),
            run_count: agent.run_count + 1,
            fail_count: error ? agent.fail_count + 1 : agent.fail_count,
        });
    }
    catch (err) {
        const msg = err instanceof Error ? err.message : String(err);

        await eprintln(`agentd: failed to update agent status: ${msg}`);
    }

    if (!error) {
        await println(`agentd: agent '${agent.name}' completed`);

        if (result) {
            // Log a preview of the result
            const preview = result.length > 100
                ? result.substring(0, 100) + '...'
                : result;

            await println(`agentd: result: ${preview}`);
        }
    }
    else {
        await eprintln(`agentd: agent '${agent.name}' failed: ${error}`);
    }
}

// =============================================================================
// MAIN
// =============================================================================

export default async function main(): Promise<void> {
    const pid = await getpid();

    await println(`agentd: starting (pid ${pid})`);

    // Handle shutdown
    let running = true;

    onSignal(() => {
        running = false;
        println('agentd: received shutdown signal');
    });

    // Subscribe to kernel ticks
    await subscribeTicks();
    await println('agentd: subscribed to kernel ticks');

    // Track last check minute to avoid duplicate runs
    let lastCheckMinute = -1;

    // Tick handler - check agents every minute
    onTick(async (_dt, _now, seq) => {
        if (!running) {
            return;
        }

        const now = new Date();
        const currentMinute = now.getMinutes();

        // Only check once per minute
        if (currentMinute === lastCheckMinute) {
            return;
        }

        lastCheckMinute = currentMinute;

        // Heartbeat every 60 ticks
        if (seq % 60 === 0) {
            await println(`agentd: heartbeat tick=${seq}`);
        }

        // Query enabled agents
        let agents: Agent[];

        try {
            agents = await collect<Agent>('ems:select', 'agent', {
                where: { enabled: true },
            });
        }
        catch {
            // Model may not exist yet on first boot
            return;
        }

        // Check each agent's schedule
        for (const agent of agents) {
            if (matchesCron(agent.schedule, now)) {
                // Run agent in background (don't await)
                executeAgent(agent).catch(async err => {
                    const msg = err instanceof Error ? err.message : String(err);

                    await eprintln(`agentd: unhandled error in agent '${agent.name}': ${msg}`);
                });
            }
        }
    });

    // Keep running
    while (running) {
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    await println('agentd: shutdown complete');
}
