/**
 * Cron API Routes - Scheduled Job Management
 *
 * Provides endpoints for managing scheduled jobs:
 * - List jobs: GET /api/cron
 * - Create job: POST /api/cron
 * - Get job: GET /api/cron/:pid
 * - Update job: PATCH /api/cron/:pid
 * - Delete job: DELETE /api/cron/:pid
 * - Enable job: POST /api/cron/:pid/enable
 * - Disable job: POST /api/cron/:pid/disable
 *
 * All endpoints require sudo access.
 */

// Collection endpoints
export { default as CronList } from './GET.js';
export { default as CronCreate } from './POST.js';

// Individual job endpoints
export { default as CronGet } from './:pid/GET.js';
export { default as CronUpdate } from './:pid/PATCH.js';
export { default as CronDelete } from './:pid/DELETE.js';

// Job control endpoints
export { default as CronEnable } from './:pid/enable/POST.js';
export { default as CronDisable } from './:pid/disable/POST.js';
