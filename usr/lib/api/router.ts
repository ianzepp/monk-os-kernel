/**
 * Op Router
 *
 * Pattern matching and handler resolution for op-based routing.
 * Supports exact matches and wildcards (*).
 */

import type { Response } from '@src/message';
import type { OpHandler, Middleware, OpContext, OpRoute } from './types';

/**
 * Internal route definition.
 */
interface Route {
    pattern: string;
    regex: RegExp;
    paramNames: string[];
    middlewares: Middleware[];
    handler?: OpHandler;
    handlerPath?: string;
}

/**
 * Create a regex and param names from an op pattern.
 *
 * Examples:
 *   "auth:login"     -> /^auth:login$/, []
 *   "data:*"         -> /^data:([^:]+)$/, ['_0']
 *   "data:*:*"       -> /^data:([^:]+):([^:]+)$/, ['_0', '_1']
 *   "*"              -> /^([^:]+)$/, ['_0']
 */
function compilePattern(pattern: string): { regex: RegExp; paramNames: string[] } {
    const paramNames: string[] = [];
    let paramIndex = 0;

    const regexStr = pattern
        .split(':')
        .map((segment) => {
            if (segment === '*') {
                paramNames.push(`_${paramIndex++}`);
                return '([^:]+)';
            }
            // Escape special regex characters
            return segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        })
        .join(':');

    return {
        regex: new RegExp(`^${regexStr}$`),
        paramNames,
    };
}

/**
 * Op Router class.
 */
export class OpRouter {
    private routes: Route[] = [];
    private patternMiddleware: Map<string, Middleware[]> = new Map();
    private handlerCache: Map<string, OpHandler> = new Map();

    /**
     * Add or get a route for a pattern.
     */
    op(pattern: string): OpRoute {
        // Check if route already exists
        let route = this.routes.find((r) => r.pattern === pattern);

        if (!route) {
            const { regex, paramNames } = compilePattern(pattern);
            route = {
                pattern,
                regex,
                paramNames,
                middlewares: [],
            };
            this.routes.push(route);
        }

        // Return fluent builder
        const self = this;
        const builder: OpRoute = {
            middleware(...mw: Middleware[]): OpRoute {
                route!.middlewares.push(...mw);
                return builder;
            },

            handler(fn: OpHandler): OpRoute {
                route!.handler = fn;
                return builder;
            },

            pipe(path: string): OpRoute {
                route!.handlerPath = path;
                return builder;
            },
        };

        return builder;
    }

    /**
     * Add middleware to a pattern.
     * Middleware is applied to all ops matching the pattern.
     */
    use(pattern: string, ...middleware: Middleware[]): void {
        const existing = this.patternMiddleware.get(pattern) ?? [];
        this.patternMiddleware.set(pattern, [...existing, ...middleware]);
    }

    /**
     * Resolve an op to a handler with middleware chain.
     */
    async resolve(op: string): Promise<{
        handler: OpHandler;
        params: Record<string, string>;
    } | null> {
        // Find matching route
        for (const route of this.routes) {
            const match = op.match(route.regex);
            if (match) {
                // Extract params
                const params: Record<string, string> = {};
                route.paramNames.forEach((name, i) => {
                    params[name] = match[i + 1]!;
                });

                // Get handler
                let handler = route.handler;
                if (!handler && route.handlerPath) {
                    handler = await this.loadHandler(route.handlerPath, op);
                }

                if (!handler) {
                    return null;
                }

                // Collect applicable middleware
                const middlewares = this.collectMiddleware(op, route);

                // Wrap handler with middleware chain
                const wrappedHandler = this.wrapWithMiddleware(handler, middlewares);

                return { handler: wrappedHandler, params };
            }
        }

        return null;
    }

    /**
     * Load a handler from a file path.
     */
    private async loadHandler(path: string, op: string): Promise<OpHandler | undefined> {
        // If path ends with /, it's a directory - append op suffix
        let finalPath = path;
        if (path.endsWith('/')) {
            const suffix = op.split(':').pop();
            finalPath = `${path}${suffix}.ts`;
        }

        // Check cache
        if (this.handlerCache.has(finalPath)) {
            return this.handlerCache.get(finalPath);
        }

        try {
            const module = await import(finalPath);
            const handler = module.default as OpHandler;
            this.handlerCache.set(finalPath, handler);
            return handler;
        } catch (err) {
            console.error(`Failed to load handler from ${finalPath}:`, err);
            return undefined;
        }
    }

    /**
     * Collect all middleware that applies to an op.
     */
    private collectMiddleware(op: string, route: Route): Middleware[] {
        const result: Middleware[] = [];

        // Add pattern-based middleware (in order of registration)
        for (const [pattern, mws] of this.patternMiddleware) {
            const { regex } = compilePattern(pattern);
            if (regex.test(op)) {
                result.push(...mws);
            }
        }

        // Add route-specific middleware
        result.push(...route.middlewares);

        return result;
    }

    /**
     * Wrap a handler with middleware chain.
     */
    private wrapWithMiddleware(handler: OpHandler, middlewares: Middleware[]): OpHandler {
        if (middlewares.length === 0) {
            return handler;
        }

        // Build chain from right to left
        return middlewares.reduceRight<OpHandler>(
            (next, mw) => {
                return (ctx: OpContext) => mw(ctx, () => next(ctx));
            },
            handler
        );
    }

    /**
     * List all registered patterns (for debugging).
     */
    patterns(): string[] {
        return this.routes.map((r) => r.pattern);
    }
}

/**
 * Create a default async generator that yields an error.
 */
export async function* notFoundHandler(ctx: OpContext): AsyncIterable<Response> {
    yield {
        op: 'error',
        data: { code: 'NOT_FOUND', message: `Unknown op: ${ctx.msg.op}` },
    };
}
