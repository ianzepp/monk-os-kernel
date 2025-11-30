/**
 * Describe API Route Barrel Export
 *
 * Model management operations using clean naming convention:
 * - Model operations: ModelGet, ModelPost, ModelPut, ModelDelete
 * - Field operations: FieldsList, FieldGet, FieldPost, FieldPut, FieldDelete
 */

// Model management operations
export { default as ModelList } from '@src/routes/api/describe/GET.js';
export { default as ModelGet } from '@src/routes/api/describe/:model/GET.js';
export { default as ModelPost } from '@src/routes/api/describe/:model/POST.js';
export { default as ModelPut } from '@src/routes/api/describe/:model/PUT.js';
export { default as ModelDelete } from '@src/routes/api/describe/:model/DELETE.js';

// Field management operations
export { default as FieldsList } from '@src/routes/api/describe/:model/fields/GET.js';
export { default as FieldsPost } from '@src/routes/api/describe/:model/fields/POST.js';
export { default as FieldsPut } from '@src/routes/api/describe/:model/fields/PUT.js';
export { default as FieldGet } from '@src/routes/api/describe/:model/fields/:field/GET.js';
export { default as FieldPost } from '@src/routes/api/describe/:model/fields/:field/POST.js';
export { default as FieldPut } from '@src/routes/api/describe/:model/fields/:field/PUT.js';
export { default as FieldDelete } from '@src/routes/api/describe/:model/fields/:field/DELETE.js';
