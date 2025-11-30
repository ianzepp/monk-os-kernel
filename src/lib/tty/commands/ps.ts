/**
 * ps - List processes
 */

import type { CommandHandler } from './shared.js';
import { listProcesses, type ProcessState } from '@src/lib/process.js';

/**
 * Format state for display
 */
function formatState(state: ProcessState): string {
    switch (state) {
        case 'R': return 'Running';
        case 'S': return 'Sleeping';
        case 'Z': return 'Zombie';
        case 'T': return 'Stopped';
        case 'X': return 'Dead';
        default: return state;
    }
}

export const ps: CommandHandler = async (session, _fs, args, io) => {
    // Parse options
    const showAll = args.includes('-a') || args.includes('--all');

    try {
        // Fetch all processes, filter client-side
        const allProcesses = await listProcesses(session.tenant);

        // Filter to running/sleeping unless -a flag
        const filtered = showAll
            ? allProcesses
            : allProcesses.filter(p => p.state === 'R' || p.state === 'S');

        if (filtered.length === 0) {
            // No output for empty list (like Unix ps)
            return 0;
        }

        // Header
        io.stdout.write('  PID  PPID  STATE     TYPE      UID       COMMAND\n');

        for (const proc of filtered) {
            const pid = String(proc.pid).padStart(5);
            const ppid = proc.ppid ? String(proc.ppid).padStart(5) : '    -';
            const state = formatState(proc.state).padEnd(9);
            const type = proc.type.padEnd(9);
            const uid = proc.uid.slice(0, 8).padEnd(9);

            // Show comm and first few args
            let command = proc.comm;
            if (proc.cmdline.length > 1) {
                const args = proc.cmdline.slice(1).join(' ');
                if (args.length > 20) {
                    command += ' ' + args.slice(0, 17) + '...';
                } else {
                    command += ' ' + args;
                }
            }

            io.stdout.write(`${pid}  ${ppid}  ${state} ${type} ${uid} ${command}\n`);
        }

        return 0;

    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        io.stderr.write(`ps: ${message}\n`);
        return 1;
    }
};
