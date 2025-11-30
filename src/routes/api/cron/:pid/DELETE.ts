import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { Crontab } from '@src/lib/crontab.js';

/**
 * DELETE /api/cron/:pid - Delete a cron job
 *
 * Permanently removes a scheduled job.
 * Requires sudo access.
 *
 * Response:
 * {
 *   "message": "Cron job deleted"
 * }
 */
export default withTransaction(async ({ system, params }) => {
    if (!system.isSudo()) {
        throw HttpErrors.forbidden(
            'Deleting cron jobs requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    const pid = parseInt(params.pid, 10);
    if (isNaN(pid)) {
        throw HttpErrors.badRequest('Invalid job ID', 'INVALID_PID');
    }

    const deleted = await Crontab.delete(system.tenant, pid);
    if (!deleted) {
        throw HttpErrors.notFound('Cron job not found', 'JOB_NOT_FOUND');
    }

    return { message: 'Cron job deleted' };
});
