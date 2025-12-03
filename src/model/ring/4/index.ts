/**
 * Ring 4: Enrichment
 *
 * These observers enrich and transform record data after validation
 * but before database persistence. They modify field values to ensure
 * consistent, normalized data storage.
 *
 * Observers in this ring:
 * - TransformProcessor (50): Apply auto-transforms (lowercase, trim, etc.)
 *
 * @module model/ring/4
 */

export { TransformProcessor } from './50-transform-processor.js';
