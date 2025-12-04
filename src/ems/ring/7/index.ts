/**
 * Ring 7: Audit
 *
 * These observers record changes for compliance and debugging.
 * They run after database operations (Ring 5) to ensure only
 * successful changes are audited.
 *
 * Observers in this ring:
 * - Tracked (60): Record changes to tracked fields
 *
 * @module model/ring/7
 */

export { Tracked } from './60-tracked.js';
