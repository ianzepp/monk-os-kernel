import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { Crontab } from '@src/lib/crontab.js';

/**
 * POST /api/cron/:pid/enable - Enable a cron job
 *
 * Enables a previously disabled scheduled job.
 * The job will be scheduled to run at its next matching time.
 * Requires sudo access.
 *
 * Response:
 * {
 *   "message": "Cron job enabled"
 * }
 */
export default withTransaction(async ({ system, params }) => {
    if (!system.isSudo()) {
        throw HttpErrors.forbidden(
            'Enabling cron jobs requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    const pid = parseInt(params.pid, 10);
    if (isNaN(pid)) {
        throw HttpErrors.badRequest('Invalid job ID', 'INVALID_PID');
    }

    const enabled = await Crontab.enable(system.tenant, pid);
    if (!enabled) {
        throw HttpErrors.notFound('Cron job not found', 'JOB_NOT_FOUND');
    }

    return { message: 'Cron job enabled' };
});
