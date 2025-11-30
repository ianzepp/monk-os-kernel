/**
 * ACLs API Route Barrel Export
 *
 * Access Control Lists management routes for record-level permissions.
 * These routes allow administrators to manage user access to specific records.
 *
 * Route Structure:
 * - Record ACL operations: /api/acls/:model/:id (GET, POST, PUT, DELETE)
 *
 * @see docs/routes/ACLS_API.md
 */

// Record ACL operations (with model and record ID parameters)
export { default as RecordAclGet } from '@src/routes/api/acls/:model/:id/GET.js';
export { default as RecordAclPost } from '@src/routes/api/acls/:model/:id/POST.js';
export { default as RecordAclPut } from '@src/routes/api/acls/:model/:id/PUT.js';
export { default as RecordAclDelete } from '@src/routes/api/acls/:model/:id/DELETE.js';
