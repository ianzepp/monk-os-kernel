import type { Context } from 'hono';
import { readFileSync, existsSync, realpathSync } from 'fs';
import { join, resolve } from 'path';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * GET /docs/* - Get API documentation (endpoint-specific or API overview)
 *
 * Supports three patterns:
 * 1. App Docs: /docs/app/mcp → node_modules/@monk-app/mcp/dist/docs/PUBLIC.md
 * 2. API Overview: /docs/api/data → api/data/PUBLIC.md
 * 3. Endpoint-Specific: /docs/api/data/model/GET → api/data/:model/GET.md
 *
 * Mapping: /docs/{path} → src/routes/{path}/PUBLIC.md or {METHOD}.md
 *
 * @see Self-documenting API pattern for CLI and AI integration
 */
export default async function (context: Context) {
    // Extract path from URL, removing /docs prefix
    const url = new URL(context.req.url);
    const endpoint = url.pathname.replace(/^\/docs\/?/, '');
    const segments = endpoint.split('/').filter(s => s.length > 0);

    if (segments.length === 0) {
        throw HttpErrors.badRequest('Documentation path is required', 'DOCS_PATH_MISSING');
    }

    // Pattern 1: App documentation - /docs/app/{appName}
    if (segments[0] === 'app' && segments.length >= 2) {
        const appName = segments[1];
        const subPath = segments.slice(2).join('/');
        return serveAppDocs(context, appName, subPath);
    }

    // Determine base directory based on environment
    const isDevelopment = process.env.NODE_ENV === 'development';
    const baseDir = isDevelopment ? 'src' : 'dist';

    // Check if last segment is an HTTP method
    const lastSegment = segments[segments.length - 1];
    const validMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'];
    const isMethodRequest = validMethods.includes(lastSegment.toUpperCase());

    let mdFilePath: string | null = null;

    if (isMethodRequest) {
        // Pattern 1: Endpoint-specific documentation (METHOD.md)
        // Example: /docs/api/data/model/GET → api/data/:model/GET.md
        const method = lastSegment.toUpperCase();
        const pathSegments = segments.slice(0, -1);

        // Known placeholder mappings
        const placeholderMap: Record<string, string> = {
            'model': ':model',
            'field': ':field',
            'id': ':id',
            'relationship': ':relationship',
            'child': ':child',
        };

        // Try to find the documentation file with placeholder resolution
        mdFilePath = findMethodDocumentation(
            process.cwd(),
            baseDir,
            pathSegments,
            method,
            placeholderMap
        );

        if (!mdFilePath) {
            throw HttpErrors.notFound(
                `Endpoint documentation not found: ${endpoint}. Try /docs/ to see available APIs.`,
                'ENDPOINT_DOCS_NOT_FOUND'
            );
        }
    } else {
        // Pattern 2: API overview documentation (PUBLIC.md)
        // Example: /docs/api/data → api/data/PUBLIC.md
        // Also supports shorthand: /docs/data → api/data/PUBLIC.md
        const apiDir = join(process.cwd(), baseDir, 'routes', ...segments);
        const publicPath = join(apiDir, 'PUBLIC.md');

        // Try with api/ prefix if direct path doesn't exist (shorthand support)
        const apiPrefixDir = join(process.cwd(), baseDir, 'routes', 'api', ...segments);
        const apiPrefixPath = join(apiPrefixDir, 'PUBLIC.md');

        if (existsSync(publicPath)) {
            mdFilePath = publicPath;
        } else if (existsSync(apiPrefixPath)) {
            mdFilePath = apiPrefixPath;
        } else {
            throw HttpErrors.notFound(
                `API documentation not found: ${endpoint}. Try /docs/ to see available APIs.`,
                'API_DOCS_NOT_FOUND'
            );
        }
    }

    try {
        // Read markdown content
        const content = readFileSync(mdFilePath, 'utf8');

        // Set proper content-type for markdown
        context.header('Content-Type', 'text/markdown; charset=utf-8');

        // Return markdown content directly (not JSON)
        return context.text(content);
    } catch (error) {
        throw HttpErrors.internal(
            'Failed to read documentation file',
            'DOCS_READ_ERROR'
        );
    }
}

/**
 * Find method-specific documentation file using placeholder resolution
 *
 * Strategy:
 * 1. Try exact path first
 * 2. Replace last N segments with placeholders and try
 * 3. Work backwards replacing more segments
 *
 * Example: /docs/api/data/model/GET
 * - Try: api/data/model/GET.md
 * - Try: api/data/:model/GET.md (replace 'model' with ':model')
 * - Try: api/:data/:model/GET.md (unlikely but possible)
 */
function findMethodDocumentation(
    cwd: string,
    baseDir: string,
    pathSegments: string[],
    method: string,
    placeholderMap: Record<string, string>
): string | null {
    const pathsToTry: string[] = [];

    // Strategy 1: Try exact path
    pathsToTry.push(join(cwd, baseDir, 'routes', ...pathSegments, `${method}.md`));

    // Strategy 2: Replace each segment from right to left with placeholders
    for (let i = pathSegments.length - 1; i >= 0; i--) {
        const segment = pathSegments[i];
        const placeholder = placeholderMap[segment.toLowerCase()];

        if (placeholder) {
            // Create a new path array with this segment replaced
            const modifiedSegments = [...pathSegments];
            modifiedSegments[i] = placeholder;
            pathsToTry.push(join(cwd, baseDir, 'routes', ...modifiedSegments, `${method}.md`));
        }
    }

    // Strategy 3: Try common multi-placeholder patterns
    // Pattern: model → :model
    if (pathSegments.length === 3 && pathSegments[2] === 'model') {
        const base = pathSegments.slice(0, 2);
        pathsToTry.push(join(cwd, baseDir, 'routes', ...base, ':model', `${method}.md`));
    }

    // Pattern: model/id → :model/:id
    // Pattern: model/field → :model/fields/:field
    if (pathSegments.length === 4 && pathSegments[2] === 'model') {
        const base = pathSegments.slice(0, 2);
        const lastSegment = pathSegments[3];
        const lastPlaceholder = placeholderMap[lastSegment.toLowerCase()];
        if (lastPlaceholder) {
            pathsToTry.push(join(cwd, baseDir, 'routes', ...base, ':model', lastPlaceholder, `${method}.md`));
        }
    }

    // Pattern: model/id/relationship → :model/:id/:relationship
    if (pathSegments.length === 5) {
        const base = pathSegments.slice(0, 2);
        pathsToTry.push(join(cwd, baseDir, 'routes', ...base, ':model', ':id', ':relationship', `${method}.md`));
    }

    // Pattern: model/id/relationship/child → :model/:id/:relationship/:child
    if (pathSegments.length === 6) {
        const base = pathSegments.slice(0, 2);
        pathsToTry.push(join(cwd, baseDir, 'routes', ...base, ':model', ':id', ':relationship', ':child', `${method}.md`));
    }

    // Try each path until we find one that exists
    for (const path of pathsToTry) {
        if (existsSync(path)) {
            return path;
        }
    }

    return null;
}

/**
 * Serve documentation from an app package.
 *
 * Looks for docs in: node_modules/@monk-app/{appName}/dist/docs/
 *
 * Patterns:
 * - /docs/app/mcp → PUBLIC.md
 * - /docs/app/mcp/tools → tools.md or tools/PUBLIC.md
 */
async function serveAppDocs(context: Context, appName: string, subPath: string): Promise<Response> {
    // Security: Validate appName contains only safe characters (alphanumeric, dash, underscore)
    if (!/^[a-zA-Z0-9_-]+$/.test(appName)) {
        throw HttpErrors.badRequest('Invalid app name', 'INVALID_APP_NAME');
    }

    // Security: Reject path traversal attempts in subPath
    if (subPath.includes('..') || subPath.includes('\0')) {
        throw HttpErrors.badRequest('Invalid documentation path', 'INVALID_PATH');
    }

    const appDocsDir = resolve(process.cwd(), 'node_modules', '@monk-app', appName, 'dist', 'docs');

    // Determine which file to serve
    let mdFilePath: string | null = null;

    if (!subPath) {
        // Root app docs: PUBLIC.md
        mdFilePath = join(appDocsDir, 'PUBLIC.md');
    } else {
        // Sub-path: try {subPath}.md then {subPath}/PUBLIC.md
        const directPath = join(appDocsDir, `${subPath}.md`);
        const publicPath = join(appDocsDir, subPath, 'PUBLIC.md');

        if (existsSync(directPath)) {
            mdFilePath = directPath;
        } else if (existsSync(publicPath)) {
            mdFilePath = publicPath;
        }
    }

    if (!mdFilePath || !existsSync(mdFilePath)) {
        throw HttpErrors.notFound(
            `App documentation not found: @monk-app/${appName}${subPath ? '/' + subPath : ''}`,
            'APP_DOCS_NOT_FOUND'
        );
    }

    // Security: Verify resolved path is within the expected docs directory
    const realPath = realpathSync(mdFilePath);
    if (!realPath.startsWith(appDocsDir)) {
        throw HttpErrors.badRequest('Invalid documentation path', 'INVALID_PATH');
    }

    try {
        const content = readFileSync(realPath, 'utf8');
        context.header('Content-Type', 'text/markdown; charset=utf-8');
        return context.text(content);
    } catch (error) {
        throw HttpErrors.internal('Failed to read app documentation', 'APP_DOCS_READ_ERROR');
    }
}
