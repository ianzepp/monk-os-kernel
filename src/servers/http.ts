/**
 * HTTP Server
 *
 * Hono-based HTTP API server for Monk.
 * Handles all REST API routes, middleware, and app packages.
 */

import { Hono } from 'hono';

import { createSuccessResponse, createInternalError } from '@src/lib/api-helpers.js';
import { setHonoApp as setInternalApiHonoApp } from '@src/lib/internal-api.js';

// Middleware
import * as middleware from '@src/lib/middleware/index.js';

// Route handlers
import * as authRoutes from '@src/routes/auth/routes.js';
import * as userRoutes from '@src/routes/api/user/routes.js';
import * as dataRoutes from '@src/routes/api/data/routes.js';
import * as describeRoutes from '@src/routes/api/describe/routes.js';
import * as aclsRoutes from '@src/routes/api/acls/routes.js';
import * as statRoutes from '@src/routes/api/stat/routes.js';
import * as docsRoutes from '@src/routes/docs/routes.js';
import * as trackedRoutes from '@src/routes/api/tracked/routes.js';
import * as trashedRoutes from '@src/routes/api/trashed/routes.js';
import * as cronRoutes from '@src/routes/api/cron/routes.js';
import * as agentRoutes from '@src/routes/api/agent/routes.js';
import * as fsRoutes from '@src/routes/fs/routes.js';

// Public endpoints
import RootGet from '@src/routes/root/GET.js';
import HealthGet from '@src/routes/health/GET.js';

// Special protected endpoints
import BulkPost from '@src/routes/api/bulk/POST.js';
import BulkExportPost from '@src/routes/api/bulk/export/POST.js';
import BulkImportPost from '@src/routes/api/bulk/import/POST.js';
import FindModelPost from '@src/routes/api/find/:model/POST.js';
import FindTargetGet from '@src/routes/api/find/:model/:target/GET.js';
import AggregateModelGet from '@src/routes/api/aggregate/:model/GET.js';
import AggregateModelPost from '@src/routes/api/aggregate/:model/POST.js';

/**
 * Create and configure the Hono HTTP app
 */
export function createHttpApp(): Hono {
    const app = new Hono();

    // Request tracking middleware (first - database health check + analytics)
    app.use('*', middleware.requestTrackerMiddleware);

    // Request logging middleware
    app.use('*', async (c, next) => {
        const start = Date.now();
        const method = c.req.method;
        const path = c.req.path;

        const result = await next();

        const duration = Date.now() - start;
        const status = c.res.status;

        console.info('Request completed', { method, path, status, duration });

        return result;
    });

    // Apply response pipeline to root and health endpoints
    app.use('/', middleware.formatDetectorMiddleware);
    app.use('/', middleware.responseTransformerMiddleware);
    app.use('/health', middleware.formatDetectorMiddleware);
    app.use('/health', middleware.responseTransformerMiddleware);

    // Root endpoint
    app.get('/', RootGet);

    // Health check endpoint (public, no authentication required)
    app.get('/health', HealthGet);

    // Public routes (no authentication required)
    app.use('/auth/*', middleware.bodyParserMiddleware);
    app.use('/auth/*', middleware.formatDetectorMiddleware);
    app.use('/auth/*', middleware.responseTransformerMiddleware);

    // /docs/* routes are public (no auth middleware applied)

    // Protected API routes - require authentication
    app.use('/api/*', middleware.bodyParserMiddleware);
    app.use('/api/*', middleware.authValidatorMiddleware);
    app.use('/api/*', middleware.formatDetectorMiddleware);
    app.use('/api/*', middleware.responseTransformerMiddleware);
    app.use('/api/*', middleware.contextInitializerMiddleware);

    // FS routes - auth only, uses runTransaction() internally
    app.use('/fs/*', middleware.authValidatorMiddleware);

    // Filesystem routes
    app.get('/fs/*', fsRoutes.FsGet);
    app.put('/fs/*', fsRoutes.FsPut);
    app.delete('/fs/*', fsRoutes.FsDelete);

    // Public docs routes (no authentication required)
    app.get('/docs', docsRoutes.ReadmeGet);
    app.get('/docs/*', docsRoutes.ApiEndpointGet);

    // App packages - dynamically loaded
    registerAppRoutes(app);

    // Internal API (for fire-and-forget background jobs)
    setInternalApiHonoApp(app);

    // Auth routes
    app.post('/auth/login', authRoutes.LoginPost);
    app.post('/auth/register', authRoutes.RegisterPost);
    app.post('/auth/refresh', authRoutes.RefreshPost);
    app.get('/auth/tenants', authRoutes.TenantsGet);

    // Describe API routes
    app.get('/api/describe', describeRoutes.ModelList);
    app.post('/api/describe/:model', describeRoutes.ModelPost);
    app.get('/api/describe/:model', describeRoutes.ModelGet);
    app.put('/api/describe/:model', describeRoutes.ModelPut);
    app.delete('/api/describe/:model', describeRoutes.ModelDelete);

    // Field-level Describe API routes
    app.get('/api/describe/:model/fields', describeRoutes.FieldsList);
    app.post('/api/describe/:model/fields', describeRoutes.FieldsPost);
    app.put('/api/describe/:model/fields', describeRoutes.FieldsPut);
    app.post('/api/describe/:model/fields/:field', describeRoutes.FieldPost);
    app.get('/api/describe/:model/fields/:field', describeRoutes.FieldGet);
    app.put('/api/describe/:model/fields/:field', describeRoutes.FieldPut);
    app.delete('/api/describe/:model/fields/:field', describeRoutes.FieldDelete);

    // Data API routes
    app.post('/api/data/:model', dataRoutes.ModelPost);
    app.get('/api/data/:model', dataRoutes.ModelGet);
    app.put('/api/data/:model', dataRoutes.ModelPut);
    app.delete('/api/data/:model', dataRoutes.ModelDelete);

    app.get('/api/data/:model/:id', dataRoutes.RecordGet);
    app.put('/api/data/:model/:id', dataRoutes.RecordPut);
    app.delete('/api/data/:model/:id', dataRoutes.RecordDelete);

    app.get('/api/data/:model/:id/:relationship', dataRoutes.RelationshipGet);
    app.post('/api/data/:model/:id/:relationship', dataRoutes.RelationshipPost);
    app.put('/api/data/:model/:id/:relationship', dataRoutes.RelationshipPut);
    app.delete('/api/data/:model/:id/:relationship', dataRoutes.RelationshipDelete);
    app.get('/api/data/:model/:id/:relationship/:child', dataRoutes.NestedRecordGet);
    app.put('/api/data/:model/:id/:relationship/:child', dataRoutes.NestedRecordPut);
    app.delete('/api/data/:model/:id/:relationship/:child', dataRoutes.NestedRecordDelete);

    // Find API routes
    app.post('/api/find/:model', FindModelPost);
    app.get('/api/find/:model/:target', FindTargetGet);

    // Aggregate API routes
    app.get('/api/aggregate/:model', AggregateModelGet);
    app.post('/api/aggregate/:model', AggregateModelPost);

    // Bulk API routes
    app.post('/api/bulk', BulkPost);
    app.post('/api/bulk/export', BulkExportPost);
    app.post('/api/bulk/import', BulkImportPost);

    // User API routes
    app.get('/api/user', userRoutes.UserList);
    app.post('/api/user', userRoutes.UserCreate);
    app.post('/api/user/sudo', userRoutes.SudoPost);
    app.post('/api/user/fake', userRoutes.FakePost);
    app.get('/api/user/whoami', (c) => c.redirect('/api/user/me', 301));
    app.get('/api/user/:id', userRoutes.UserGet);
    app.put('/api/user/:id', userRoutes.UserUpdate);
    app.delete('/api/user/:id', userRoutes.UserDelete);
    app.post('/api/user/:id/password', userRoutes.PasswordPost);
    app.get('/api/user/:id/keys', userRoutes.KeysList);
    app.post('/api/user/:id/keys', userRoutes.KeysCreate);
    app.delete('/api/user/:id/keys/:keyId', userRoutes.KeysDelete);

    // ACLs API routes
    app.get('/api/acls/:model/:id', aclsRoutes.RecordAclGet);
    app.post('/api/acls/:model/:id', aclsRoutes.RecordAclPost);
    app.put('/api/acls/:model/:id', aclsRoutes.RecordAclPut);
    app.delete('/api/acls/:model/:id', aclsRoutes.RecordAclDelete);

    // Stat API routes
    app.get('/api/stat/:model/:id', statRoutes.RecordGet);

    // Tracked API routes
    app.get('/api/tracked/:model/:id', trackedRoutes.RecordTrackedGet);
    app.get('/api/tracked/:model/:id/:change', trackedRoutes.ChangeGet);

    // Trashed API routes
    app.get('/api/trashed', trashedRoutes.TrashedGet);
    app.get('/api/trashed/:model', trashedRoutes.ModelTrashedGet);
    app.post('/api/trashed/:model', trashedRoutes.ModelTrashedPost);
    app.delete('/api/trashed/:model', trashedRoutes.ModelTrashedDelete);
    app.get('/api/trashed/:model/:id', trashedRoutes.RecordTrashedGet);
    app.post('/api/trashed/:model/:id', trashedRoutes.RecordTrashedPost);
    app.delete('/api/trashed/:model/:id', trashedRoutes.RecordTrashedDelete);

    // Cron API routes
    app.get('/api/cron', cronRoutes.CronList);
    app.post('/api/cron', cronRoutes.CronCreate);
    app.get('/api/cron/:pid', cronRoutes.CronGet);
    app.patch('/api/cron/:pid', cronRoutes.CronUpdate);
    app.delete('/api/cron/:pid', cronRoutes.CronDelete);
    app.post('/api/cron/:pid/enable', cronRoutes.CronEnable);
    app.post('/api/cron/:pid/disable', cronRoutes.CronDisable);

    // Agent API route
    app.post('/api/agent', agentRoutes.AgentPost);

    // Error handling
    app.onError((err, c) => createInternalError(c, err));

    // 404 handler
    app.notFound((c) => {
        return c.json(
            {
                success: false,
                error: 'Not found',
                error_code: 'NOT_FOUND',
            },
            404
        );
    });

    return app;
}

/**
 * Register dynamic app package routes
 */
function registerAppRoutes(app: Hono): void {
    // Track pending app load promises to prevent duplicate loads
    const appLoadPromises = new Map<string, Promise<Hono | null>>();

    // Lazy app loader - initializes app on first request
    app.all('/app/:appName/*', async (c) => {
        const appName = c.req.param('appName');

        // Import loader functions
        const { loadHybridApp, appHasTenantModels } = await import('@src/lib/apps/loader.js');

        // Check if app has tenant models (requires JWT auth)
        const needsAuth = appHasTenantModels(appName);

        // If app has tenant models, ensure user is authenticated
        if (needsAuth) {
            const jwtPayload = c.get('jwtPayload');
            if (!jwtPayload) {
                try {
                    await middleware.authValidatorMiddleware(c, async () => {});
                } catch (error) {
                    return c.json(
                        {
                            success: false,
                            error: 'Authentication required for this app',
                            error_code: 'AUTH_REQUIRED',
                        },
                        401
                    );
                }
            }
        }

        // Load app (handles both external and tenant models)
        let loadPromise = appLoadPromises.get(appName);
        if (!loadPromise) {
            loadPromise = loadHybridApp(appName, app, c);
            appLoadPromises.set(appName, loadPromise);
        }

        let appInstance: Hono | null = null;
        try {
            appInstance = await loadPromise;
        } finally {
            appLoadPromises.delete(appName);
        }

        // After first load, check again if auth is needed (models now cached)
        if (!needsAuth && appHasTenantModels(appName)) {
            const jwtPayload = c.get('jwtPayload');
            if (!jwtPayload) {
                try {
                    await middleware.authValidatorMiddleware(c, async () => {});
                    // Re-load to install tenant models now that we have auth
                    appInstance = await loadHybridApp(appName, app, c);
                } catch (error) {
                    return c.json(
                        {
                            success: false,
                            error: 'Authentication required for this app',
                            error_code: 'AUTH_REQUIRED',
                        },
                        401
                    );
                }
            }
        }

        if (!appInstance) {
            return c.json(
                { success: false, error: `App not found: ${appName}`, error_code: 'APP_NOT_FOUND' },
                404
            );
        }

        // Rewrite URL to remove /app/{appName} prefix for the sub-app
        const originalPath = c.req.path;
        const appPrefix = `/app/${appName}`;
        const subPath = originalPath.slice(appPrefix.length) || '/';

        // Create new request with rewritten path
        const url = new URL(c.req.url);
        url.pathname = subPath;

        // Forward the original Authorization header
        const headers = new Headers(c.req.raw.headers);

        const newRequest = new Request(url.toString(), {
            method: c.req.method,
            headers,
            body: c.req.raw.body,
            // @ts-ignore - duplex is needed for streaming bodies
            duplex: 'half',
        });

        return appInstance.fetch(newRequest);
    });
}

export interface HttpServerHandle {
    app: Hono;
    server: ReturnType<typeof Bun.serve>;
    stop: () => void;
}

/**
 * Start the HTTP server
 */
export function startHttpServer(port: number): HttpServerHandle {
    const app = createHttpApp();

    const server = Bun.serve({
        fetch: app.fetch,
        port,
    });

    console.info('HTTP server running', { port, url: `http://localhost:${port}` });

    return {
        app,
        server,
        stop: () => {
            server.stop();
            console.info('HTTP server stopped');
        },
    };
}
