/**
 * Tracked API Route Barrel Export
 *
 * Routes for accessing change tracking and audit trails for tracked fields.
 */

// Record tracked operations
export { default as RecordTrackedGet } from '@src/routes/api/tracked/:model/:id/GET.js';

// Specific change operations
export { default as ChangeGet } from '@src/routes/api/tracked/:model/:id/:change/GET.js';
