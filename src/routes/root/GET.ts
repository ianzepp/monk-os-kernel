import type { Context } from 'hono';
import { VERSION } from '@src/lib/version.js';

/**
 * GET / - API root endpoint
 *
 * Returns API information and available endpoints.
 * Public endpoint, no authentication required.
 */
export default function (context: Context) {
    return context.json({
        success: true,
        data: {
            name: 'Monk API',
            version: VERSION,
            description: 'Lightweight PaaS backend API',
            endpoints: {
                health: ['/health'],
                docs: [
                    '/docs',
                    '/docs/auth',
                    '/docs/describe',
                    '/docs/data',
                    '/docs/find',
                    '/docs/aggregate',
                    '/docs/bulk',
                    '/docs/user',
                    '/docs/acls',
                    '/docs/stat',
                    '/docs/tracked',
                    '/docs/trashed'
                ],
                auth: [
                    '/auth/login',
                    '/auth/register',
                    '/auth/refresh',
                    '/auth/tenants'
                ],
                describe: [
                    '/api/describe',
                    '/api/describe/:model',
                    '/api/describe/:model/fields',
                    '/api/describe/:model/fields/:field'
                ],
                data: [
                    '/api/data/:model',
                    '/api/data/:model/:id',
                    '/api/data/:model/:id/:relationship',
                    '/api/data/:model/:id/:relationship/:child'
                ],
                find: [
                    '/api/find/:model'
                ],
                aggregate: [
                    '/api/aggregate/:model'
                ],
                bulk: [
                    '/api/bulk'
                ],
                user: [
                    '/api/user',
                    '/api/user/:id',
                    '/api/user/sudo',
                    '/api/user/fake'
                ],
                acls: [
                    '/api/acls/:model/:id'
                ],
                stat: [
                    '/api/stat/:model/:id'
                ],
                tracked: [
                    '/api/tracked/:model/:id',
                    '/api/tracked/:model/:id/:change'
                ],
                trashed: [
                    '/api/trashed',
                    '/api/trashed/:model',
                    '/api/trashed/:model/:id'
                ],
                grids: [
                    '/api/grids/:id/:range',
                    '/api/grids/:id/cells'
                ]
            }
        }
    });
}
