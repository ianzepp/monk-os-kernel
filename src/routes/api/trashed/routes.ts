/**
 * Trashed API Route Barrel Export
 *
 * Routes for managing soft-deleted (trashed) records:
 * - List all trashed records across models or for a specific model
 * - Get individual trashed records
 * - Restore trashed records
 * - Permanently delete trashed records
 */

// All trashed records operations
export { default as TrashedGet } from '@src/routes/api/trashed/GET.js';

// Model-level trashed operations
export { default as ModelTrashedGet } from '@src/routes/api/trashed/:model/GET.js';
export { default as ModelTrashedPost } from '@src/routes/api/trashed/:model/POST.js';
export { default as ModelTrashedDelete } from '@src/routes/api/trashed/:model/DELETE.js';

// Record-level trashed operations
export { default as RecordTrashedGet } from '@src/routes/api/trashed/:model/:id/GET.js';
export { default as RecordTrashedPost } from '@src/routes/api/trashed/:model/:id/POST.js';
export { default as RecordTrashedDelete } from '@src/routes/api/trashed/:model/:id/DELETE.js';
