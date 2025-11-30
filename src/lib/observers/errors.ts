/**
 * Observer Error Types
 * 
 * Categorized error types for proper observer error handling and transaction management.
 */

/**
 * Base class for all observer-related errors
 */
export abstract class ObserverError extends Error {
    public readonly code: string;
    
    constructor(message: string, code: string) {
        super(message);
        this.name = this.constructor.name;
        this.code = code;
        Error.captureStackTrace?.(this, this.constructor);
    }
}

/**
 * ValidationError - Recoverable errors that should be collected and returned to user
 * 
 * These errors indicate invalid input data but don't require transaction rollback.
 * Multiple validation errors can be collected during observer execution.
 */
export class ValidationError extends ObserverError {
    public readonly field?: string;
    
    constructor(message: string, field?: string, code = 'VALIDATION_ERROR') {
        super(message, code);
        this.field = field;
    }
}

/**
 * SecurityError - Recoverable errors that violate security policies
 * 
 * These errors indicate security violations but don't require transaction rollback.
 * Examples: access denied, soft delete protection, permission violations.
 */
export class SecurityError extends ObserverError {
    public readonly context?: Record<string, any>;
    
    constructor(message: string, context?: Record<string, any>, code = 'SECURITY_ERROR') {
        super(message, code);
        this.context = context;
    }
}

/**
 * BusinessLogicError - Recoverable errors that violate business rules
 * 
 * These errors indicate business rule violations but don't require transaction rollback.
 * Examples: insufficient balance, invalid state transitions, permission denied.
 */
export class BusinessLogicError extends ObserverError {
    public readonly context?: Record<string, any>;
    
    constructor(message: string, context?: Record<string, any>, code = 'BUSINESS_LOGIC_ERROR') {
        super(message, code);
        this.context = context;
    }
}

/**
 * SystemError - Unrecoverable errors that require transaction rollback
 * 
 * These errors indicate system-level failures that should cause the entire
 * transaction to rollback. Examples: database connection failures, external API failures.
 */
export class SystemError extends ObserverError {
    public readonly originalError?: Error;
    
    constructor(message: string, originalError?: Error, code = 'SYSTEM_ERROR') {
        super(message, code);
        this.originalError = originalError;
    }
}

/**
 * ValidationWarning - Non-blocking warnings that don't affect execution
 * 
 * These warnings are logged but don't prevent the operation from continuing.
 * Examples: deprecated field usage, performance warnings, minor data inconsistencies.
 */
export class ValidationWarning {
    public readonly message: string;
    public readonly code: string;
    public readonly field?: string;
    public readonly timestamp: Date;
    
    constructor(message: string, field?: string, code = 'VALIDATION_WARNING') {
        this.message = message;
        this.field = field;
        this.code = code;
        this.timestamp = new Date();
    }
}

/**
 * Observer timeout error - thrown when observer execution exceeds time limit
 */
export class ObserverTimeoutError extends SystemError {
    public readonly timeoutMs: number;
    public readonly observerName: string;
    
    constructor(observerName: string, timeoutMs: number) {
        super(`Observer ${observerName} timed out after ${timeoutMs}ms`, undefined, 'OBSERVER_TIMEOUT');
        this.observerName = observerName;
        this.timeoutMs = timeoutMs;
    }
}

/**
 * Observer recursion limit exceeded error
 */
export class ObserverRecursionError extends SystemError {
    public readonly depth: number;
    public readonly maxDepth: number;
    
    constructor(depth: number, maxDepth: number) {
        super(`Observer recursion limit exceeded (${depth} > ${maxDepth})`, undefined, 'OBSERVER_RECURSION_LIMIT');
        this.depth = depth;
        this.maxDepth = maxDepth;
    }
}