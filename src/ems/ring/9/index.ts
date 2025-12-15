/**
 * Ring 9: Notification
 *
 * These observers handle internal events, triggers, and pub/sub notifications.
 * They run after all database, DDL, audit, and cache operations complete.
 *
 * @module ems/ring/9
 */

export { PubsubNotify } from './99-pubsub-notify.js';
