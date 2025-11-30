import type { Context } from 'hono';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { HttpErrors } from '@src/lib/errors/http-error.js';

/**
 * GET /docs - Get main API documentation as markdown
 * @see Self-documenting API pattern for CLI and AI integration
 */
export default async function (context: Context) {
    // Determine documentation path based on environment
    const isDevelopment = process.env.NODE_ENV === 'development';
    const baseDir = isDevelopment ? 'src' : 'dist';
    const publicDocsPath = join(process.cwd(), baseDir, 'routes', 'docs', 'PUBLIC.md');

    // Check if documentation exists
    if (!existsSync(publicDocsPath)) {
        throw HttpErrors.notFound('Main API documentation not found', 'DOCS_NOT_FOUND');
    }

    try {
        // Read markdown content
        const content = readFileSync(publicDocsPath, 'utf8');

        // Set proper content-type for markdown
        context.header('Content-Type', 'text/markdown; charset=utf-8');

        // Return markdown content directly (not JSON)
        return context.text(content);
    } catch (error) {
        throw HttpErrors.internal('Failed to read main API documentation', 'DOCS_READ_ERROR');
    }
}
