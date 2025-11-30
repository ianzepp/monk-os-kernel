/**
 * HttpError - Structured HTTP error handling for API responses
 *
 * IMPLEMENTATION PLAN:
 *
 * Phase 1: Core Error Class
 * - Create HttpError class extending Error
 * - Add statusCode, errorCode properties
 * - Export common error factory methods
 *
 * Phase 2: Update Describe Operations
 * - Replace all 'throw new Error()' calls in describe.ts with HttpError
 * - Map business logic errors to appropriate HTTP status codes:
 *   - 400: Model validation, parsing, required field errors
 *   - 403: Protected model modification attempts
 *   - 404: Model not found errors
 *   - 409: Model already exists (if applicable)
 *   - 422: Invalid model content/structure
 *
 * Phase 3: Update Middleware
 * - Modify responseYamlMiddleware in system-context.ts
 * - Add instanceof HttpError detection
 * - Use error.statusCode for HTTP response status
 * - Include error.errorCode in JSON error response
 * - Keep 500 default for unexpected Error instances
 *
 * Phase 4: Extend to Other APIs (Future)
 * - Apply HttpError pattern to data API routes
 * - Apply to auth API routes
 * - Standardize error response format across all APIs
 *
 * Phase 5: Enhanced Error Context (Future)
 * - Add validation details for model errors
 * - Add request context (tenant, user, operation)
 * - Add correlation IDs for error tracking
 */

/**
 * Structured HTTP error for API responses
 *
 * Separates business logic errors from HTTP transport concerns.
 * Business logic throws semantic errors, middleware handles HTTP details.
 */
export class HttpError extends Error {
    public readonly name = 'HttpError';

    constructor(
        public readonly statusCode: number,
        message: string,
        public readonly errorCode?: string,
        public readonly details?: Record<string, any>
    ) {
        super(message);

        // Maintain proper prototype chain for instanceof checks
        Object.setPrototypeOf(this, HttpError.prototype);
    }

    /**
     * Convert to JSON-serializable object for API responses
     */
    toJSON() {
        return {
            success: false,
            error: this.message,
            error_code: this.errorCode,
            status_code: this.statusCode,
            ...(this.details && { details: this.details })
        };
    }
}

/**
 * Factory methods for common HTTP error scenarios
 */
export class HttpErrors {
    static badRequest(message: string, errorCode = 'BAD_REQUEST', details?: Record<string, any>) {
        return new HttpError(400, message, errorCode, details);
    }

    static unauthorized(message = 'Unauthorized', errorCode = 'UNAUTHORIZED') {
        return new HttpError(401, message, errorCode);
    }

    static forbidden(message = 'Forbidden', errorCode = 'FORBIDDEN') {
        return new HttpError(403, message, errorCode);
    }

    static notFound(message = 'Not found', errorCode = 'NOT_FOUND') {
        return new HttpError(404, message, errorCode);
    }

    static conflict(message: string, errorCode = 'CONFLICT', details?: Record<string, any>) {
        return new HttpError(409, message, errorCode, details);
    }

    static unprocessableEntity(message: string, errorCode = 'UNPROCESSABLE_ENTITY', details?: Record<string, any>) {
        return new HttpError(422, message, errorCode, details);
    }

    static methodNotAllowed(message = 'Method not allowed', errorCode = 'METHOD_NOT_ALLOWED') {
        return new HttpError(405, message, errorCode);
    }

    static unsupportedMediaType(message: string, errorCode = 'UNSUPPORTED_MEDIA_TYPE', details?: Record<string, any>) {
        return new HttpError(415, message, errorCode, details);
    }

    static requestEntityTooLarge(message = 'Request entity too large', errorCode = 'BODY_TOO_LARGE', details?: Record<string, any>) {
        return new HttpError(413, message, errorCode, details);
    }

    static internal(message = 'Internal server error', errorCode = 'INTERNAL_ERROR') {
        return new HttpError(500, message, errorCode);
    }

    static notImplemented(message = 'Not implemented', errorCode = 'NOT_IMPLEMENTED') {
        return new HttpError(501, message, errorCode);
    }

    static serviceUnavailable(message = 'Service unavailable', errorCode = 'SERVICE_UNAVAILABLE') {
        return new HttpError(503, message, errorCode);
    }

    /**
     * Remap error code if it matches the source code
     * Preserves all error properties (message, status, details, stack)
     *
     * Use this to convert generic error codes to more specific ones in wrapper layers.
     *
     * @param error - The error to potentially remap
     * @param fromCode - The error code to match
     * @param toCode - The new error code to use if matched
     * @returns Never returns (always throws)
     *
     * @example
     * // Remap generic RECORD_NOT_FOUND to USER_NOT_FOUND
     * return await database.select404('users', filter)
     *     .catch(e => HttpErrors.remap(e, 'RECORD_NOT_FOUND', 'USER_NOT_FOUND'));
     *
     * @example
     * // Chain multiple remappings
     * return await database.createOne('users', data)
     *     .catch(e => HttpErrors.remap(e, 'RECORD_NOT_FOUND', 'USER_NOT_FOUND'))
     *     .catch(e => HttpErrors.remap(e, 'VALIDATION_ERROR', 'USER_VALIDATION_ERROR'));
     */
    static remap(error: any, fromCode: string, toCode: string): never {
        // Check both .code and .errorCode for compatibility
        if (error.code === fromCode || error.errorCode === fromCode) {
            // If it's an HttpError, preserve the instance and just change the code
            if (error instanceof HttpError) {
                (error as any).errorCode = toCode;
                throw error;
            }
            // Fallback: wrap non-HttpError with original message
            throw new HttpError(error.statusCode || 500, error.message, toCode);
        }
        throw error;
    }
}

/**
 * Type guard for HttpError instances
 */
export function isHttpError(error: unknown): error is HttpError {
    return error instanceof HttpError;
}

/**
 * Convert FSError to HttpError
 *
 * Maps POSIX error codes to appropriate HTTP status codes.
 * Used by HTTP routes that delegate to the FS layer.
 */
export function fsErrorToHttp(error: { code: string; path: string; message: string }): HttpError {
    switch (error.code) {
        case 'ENOENT':
            return HttpErrors.notFound(error.message, 'NOT_FOUND');
        case 'EEXIST':
            return HttpErrors.conflict(error.message, 'ALREADY_EXISTS');
        case 'EACCES':
            return HttpErrors.forbidden(error.message, 'ACCESS_DENIED');
        case 'EISDIR':
            return HttpErrors.badRequest(error.message, 'IS_DIRECTORY');
        case 'ENOTDIR':
            return HttpErrors.badRequest(error.message, 'NOT_DIRECTORY');
        case 'EINVAL':
            return HttpErrors.badRequest(error.message, 'INVALID_ARGUMENT');
        case 'EROFS':
            return HttpErrors.methodNotAllowed(error.message, 'READ_ONLY');
        case 'ENOTEMPTY':
            return HttpErrors.conflict(error.message, 'NOT_EMPTY');
        case 'EIO':
        default:
            return HttpErrors.internal(error.message, 'IO_ERROR');
    }
}
