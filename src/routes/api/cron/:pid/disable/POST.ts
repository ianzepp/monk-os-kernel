import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { Crontab } from '@src/lib/crontab.js';

/**
 * POST /api/cron/:pid/disable - Disable a cron job
 *
 * Disables a scheduled job without deleting it.
 * The job will not run until re-enabled.
 * Requires sudo access.
 *
 * Response:
 * {
 *   "message": "Cron job disabled"
 * }
 */
export default withTransaction(async ({ system, params }) => {
    if (!system.isSudo()) {
        throw HttpErrors.forbidden(
            'Disabling cron jobs requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    const pid = parseInt(params.pid, 10);
    if (isNaN(pid)) {
        throw HttpErrors.badRequest('Invalid job ID', 'INVALID_PID');
    }

    const disabled = await Crontab.disable(system.tenant, pid);
    if (!disabled) {
        throw HttpErrors.notFound('Cron job not found', 'JOB_NOT_FOUND');
    }

    return { message: 'Cron job disabled' };
});
