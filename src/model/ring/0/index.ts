/**
 * Ring 0: Data Preparation
 *
 * These observers prepare record data before validation and persistence.
 * They run first in the pipeline, ensuring all subsequent rings see
 * properly formatted and complete data.
 *
 * Observers in this ring:
 * - UpdateMerger (50): Set updated_at for UPDATE operations
 *
 * @module model/ring/0
 */

export { UpdateMerger } from './50-update-merger.js';
