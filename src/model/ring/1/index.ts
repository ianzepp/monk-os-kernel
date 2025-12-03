/**
 * Ring 1: Input Validation
 *
 * These observers validate input data before it reaches the database.
 * They run after Ring 0 (data preparation) and before Ring 2 (security).
 *
 * Observers in this ring:
 * - Frozen (10): Block changes to frozen models
 * - Immutable (30): Block changes to immutable fields
 * - Constraints (40): Validate types, required, min/max, pattern, enum
 *
 * @module model/ring/1
 */

export { Frozen } from './10-frozen.js';
export { Immutable } from './30-immutable.js';
export { Constraints } from './40-constraints.js';
