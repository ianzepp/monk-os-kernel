import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { Crontab } from '@src/lib/crontab.js';

/**
 * GET /api/cron - List all cron jobs for tenant
 *
 * Returns all scheduled jobs within the authenticated user's tenant.
 * Requires sudo access.
 */
export default withTransaction(async ({ system }) => {
    if (!system.isSudo()) {
        throw HttpErrors.forbidden(
            'Listing cron jobs requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    const jobs = await Crontab.list(system.tenant);
    return jobs;
});
