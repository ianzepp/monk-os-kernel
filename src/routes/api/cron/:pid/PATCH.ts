import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { Crontab } from '@src/lib/crontab.js';

/**
 * PATCH /api/cron/:pid - Update a cron job
 *
 * Updates the schedule or command of an existing job.
 * Requires sudo access.
 *
 * Request body (all fields optional):
 * {
 *   "schedule": "0 * * * *",             // New cron expression
 *   "command": "echo hello"              // New command
 * }
 *
 * Response:
 * {
 *   "message": "Cron job updated"
 * }
 */
export default withTransaction(async ({ system, params, body }) => {
    if (!system.isSudo()) {
        throw HttpErrors.forbidden(
            'Updating cron jobs requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    const pid = parseInt(params.pid, 10);
    if (isNaN(pid)) {
        throw HttpErrors.badRequest('Invalid job ID', 'INVALID_PID');
    }

    const { schedule, command } = body || {};

    if (!schedule && !command) {
        throw HttpErrors.badRequest(
            'At least one of schedule or command is required',
            'MISSING_FIELDS'
        );
    }

    // Check job exists
    const job = await Crontab.get(system.tenant, pid);
    if (!job) {
        throw HttpErrors.notFound('Cron job not found', 'JOB_NOT_FOUND');
    }

    try {
        if (schedule) {
            const updated = await Crontab.updateSchedule(system.tenant, pid, schedule);
            if (!updated) {
                throw HttpErrors.notFound('Cron job not found', 'JOB_NOT_FOUND');
            }
        }

        if (command) {
            const updated = await Crontab.updateCommand(system.tenant, pid, command);
            if (!updated) {
                throw HttpErrors.notFound('Cron job not found', 'JOB_NOT_FOUND');
            }
        }

        return { message: 'Cron job updated' };
    } catch (err) {
        if (err instanceof Error && err.message.includes('Invalid cron')) {
            throw HttpErrors.badRequest(err.message, 'INVALID_SCHEDULE');
        }
        throw err;
    }
});
