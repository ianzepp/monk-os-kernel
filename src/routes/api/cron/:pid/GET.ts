import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { Crontab } from '@src/lib/crontab.js';

/**
 * GET /api/cron/:pid - Get a specific cron job
 *
 * Returns details of a scheduled job.
 * Requires sudo access.
 */
export default withTransaction(async ({ system, params }) => {
    if (!system.isSudo()) {
        throw HttpErrors.forbidden(
            'Viewing cron jobs requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    const pid = parseInt(params.pid, 10);
    if (isNaN(pid)) {
        throw HttpErrors.badRequest('Invalid job ID', 'INVALID_PID');
    }

    const job = await Crontab.get(system.tenant, pid);
    if (!job) {
        throw HttpErrors.notFound('Cron job not found', 'JOB_NOT_FOUND');
    }

    return job;
});
