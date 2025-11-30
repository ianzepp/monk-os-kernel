/**
 * Data API Route Barrel Export
 *
 * Clean route organization using your preferred naming convention:
 * - Model operations: ModelGet, ModelPost, ModelPut, ModelDelete
 * - Record operations: RecordGet, RecordPut, RecordDelete (with ID parameter)
 * @see docs/routes/DATA_API.md
 */

// Model operations (no ID parameter)
export { default as ModelGet } from '@src/routes/api/data/:model/GET.js';
export { default as ModelPost } from '@src/routes/api/data/:model/POST.js';
export { default as ModelPut } from '@src/routes/api/data/:model/PUT.js';
export { default as ModelDelete } from '@src/routes/api/data/:model/DELETE.js';

// Record operations (with ID parameter)
export { default as RecordGet } from '@src/routes/api/data/:model/:id/GET.js';
export { default as RecordPut } from '@src/routes/api/data/:model/:id/PUT.js';
export { default as RecordDelete } from '@src/routes/api/data/:model/:id/DELETE.js';

// Relationship operations
export { default as RelationshipGet } from '@src/routes/api/data/:model/:id/:relationship/GET.js';
export { default as RelationshipPost } from '@src/routes/api/data/:model/:id/:relationship/POST.js';
export { default as RelationshipPut } from '@src/routes/api/data/:model/:id/:relationship/PUT.js';
export { default as RelationshipDelete } from '@src/routes/api/data/:model/:id/:relationship/DELETE.js';

// Nested record operations
export { default as NestedRecordGet } from '@src/routes/api/data/:model/:id/:relationship/:child/GET.js';
export { default as NestedRecordPut } from '@src/routes/api/data/:model/:id/:relationship/:child/PUT.js';
export { default as NestedRecordDelete } from '@src/routes/api/data/:model/:id/:relationship/:child/DELETE.js';
