/**
 * Observer Pipeline - Error Types
 *
 * ARCHITECTURE OVERVIEW
 * =====================
 * This module defines error types for the observer pipeline, following the
 * same pattern as HAL errors (src/hal/errors.ts). All observer errors use
 * the EOBS* prefix to avoid collision with POSIX/HAL errors.
 *
 * Error codes:
 * - EOBSINVALID (1001) - Validation failure
 * - EOBSFROZEN (1002) - Model is frozen
 * - EOBSIMMUT (1003) - Field is immutable
 * - EOBSSEC (1010) - Security violation
 * - EOBSBUS (1020) - Business rule violation
 * - EOBSSYS (1030) - System/database error
 * - EOBSTIMEOUT (1031) - Observer timeout
 * - EOBSERVER (1032) - Generic observer failure
 *
 * INVARIANTS
 * ==========
 * INV-1: All observer errors have EOBS* prefix
 * INV-2: errno values are 1000+ (avoids POSIX collision)
 * INV-3: Errors are immutable after construction
 *
 * @module model/observers/errors
 */

// =============================================================================
// BASE ERROR CLASS
// =============================================================================

/**
 * Base class for all observer pipeline errors.
 *
 * WHY separate from HALError: Observer errors are semantically different from
 * I/O errors. They represent data validation, business logic, and schema
 * enforcement failures rather than hardware/filesystem issues.
 */
export class ObserverError extends Error {
    /** Error code (e.g., 'EOBSINVALID') */
    readonly code: string;

    /** Numeric error value (1000+ range) */
    readonly errno: number;

    constructor(code: string, errno: number, message: string) {
        super(message);
        this.name = 'ObserverError';
        this.code = code;
        this.errno = errno;
    }
}

// =============================================================================
// RING 1: VALIDATION ERRORS
// =============================================================================

/**
 * Input validation failure.
 *
 * USAGE: Type mismatch, constraint violation, required field missing,
 * pattern mismatch, enum value invalid.
 */
export class EOBSINVALID extends ObserverError {
    /** Field that failed validation (if applicable) */
    readonly field?: string;

    constructor(message = 'Validation failed', field?: string) {
        super('EOBSINVALID', 1001, message);
        this.name = 'EOBSINVALID';
        this.field = field;
    }
}

/**
 * Model is frozen.
 *
 * USAGE: Any create/update/delete on a frozen model.
 */
export class EOBSFROZEN extends ObserverError {
    constructor(message = 'Model is frozen') {
        super('EOBSFROZEN', 1002, message);
        this.name = 'EOBSFROZEN';
    }
}

/**
 * Field is immutable.
 *
 * USAGE: Attempting to change an immutable field after initial set.
 */
export class EOBSIMMUT extends ObserverError {
    /** Field that is immutable */
    readonly field?: string;

    constructor(message = 'Field is immutable', field?: string) {
        super('EOBSIMMUT', 1003, message);
        this.name = 'EOBSIMMUT';
        this.field = field;
    }
}

// =============================================================================
// RING 2: SECURITY ERRORS
// =============================================================================

/**
 * Security/permission violation.
 *
 * USAGE: Sudo required, access denied, existence check failed.
 */
export class EOBSSEC extends ObserverError {
    constructor(message = 'Security violation') {
        super('EOBSSEC', 1010, message);
        this.name = 'EOBSSEC';
    }
}

// =============================================================================
// RING 3: BUSINESS LOGIC ERRORS
// =============================================================================

/**
 * Business rule violation.
 *
 * USAGE: Insufficient balance, invalid state transition, duplicate entry.
 */
export class EOBSBUS extends ObserverError {
    constructor(message = 'Business rule violation') {
        super('EOBSBUS', 1020, message);
        this.name = 'EOBSBUS';
    }
}

// =============================================================================
// RING 5+: SYSTEM ERRORS
// =============================================================================

/**
 * System/database error.
 *
 * USAGE: SQL execution failed, connection lost, timeout.
 */
export class EOBSSYS extends ObserverError {
    constructor(message = 'System error') {
        super('EOBSSYS', 1030, message);
        this.name = 'EOBSSYS';
    }
}

/**
 * Observer timeout.
 *
 * USAGE: BaseObserver.executeWithTimeout() fires this on timeout.
 */
export class EOBSTIMEOUT extends ObserverError {
    constructor(message = 'Observer timed out') {
        super('EOBSTIMEOUT', 1031, message);
        this.name = 'EOBSTIMEOUT';
    }
}

/**
 * Generic observer failure.
 *
 * USAGE: BaseObserver wraps unexpected errors in this.
 */
export class EOBSERVER extends ObserverError {
    constructor(message = 'Observer failed') {
        super('EOBSERVER', 1032, message);
        this.name = 'EOBSERVER';
    }
}

// =============================================================================
// HELPER FUNCTIONS
// =============================================================================

/**
 * Check if an error is an observer pipeline error.
 */
export function isObserverError(err: unknown): err is ObserverError {
    return err instanceof ObserverError;
}

/**
 * Check if an error is a validation error.
 */
export function isValidationError(err: unknown): err is EOBSINVALID {
    return err instanceof EOBSINVALID;
}

/**
 * Check if error has a specific code.
 */
export function hasErrorCode(err: unknown, code: string): boolean {
    return isObserverError(err) && err.code === code;
}
