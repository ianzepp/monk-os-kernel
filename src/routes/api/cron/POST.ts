import { withTransaction } from '@src/lib/api-helpers.js';
import { HttpErrors } from '@src/lib/errors/http-error.js';
import { Crontab } from '@src/lib/crontab.js';
import type { SystemInit } from '@src/lib/system.js';

/**
 * POST /api/cron - Create a new cron job
 *
 * Creates a new scheduled job within the authenticated user's tenant.
 * Requires sudo access.
 *
 * Request body:
 *   schedule: Cron expression (required), e.g., "0 * * * *"
 *   command: Shell command (required)
 *   enabled: Optional, defaults to true
 *
 * Response:
 * {
 *   "pid": 42,
 *   "message": "Cron job created"
 * }
 */
export default withTransaction(async ({ system, body }) => {
    if (!system.isSudo()) {
        throw HttpErrors.forbidden(
            'Creating cron jobs requires sudo access',
            'SUDO_REQUIRED'
        );
    }

    const { schedule, command, enabled } = body || {};

    if (!schedule) {
        throw HttpErrors.badRequest(
            'Schedule is required',
            'MISSING_SCHEDULE'
        );
    }

    if (!command) {
        throw HttpErrors.badRequest(
            'Command is required',
            'MISSING_COMMAND'
        );
    }

    // Build SystemInit from System properties
    const init: SystemInit = {
        tenant: system.tenant,
        dbType: system.dbType,
        dbName: system.dbName,
        nsName: system.nsName,
        userId: system.userId,
        access: system.access,
    };

    try {
        const pid = await Crontab.create(init, {
            schedule,
            command,
            enabled: enabled !== false,
        });

        return { pid, message: 'Cron job created' };
    } catch (err) {
        if (err instanceof Error && err.message.includes('Invalid cron')) {
            throw HttpErrors.badRequest(err.message, 'INVALID_SCHEDULE');
        }
        throw err;
    }
});
