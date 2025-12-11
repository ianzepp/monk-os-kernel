/**
 * Ring 6: Post-Database (DDL)
 *
 * These observers run after Ring 5 (database operations) and handle
 * schema changes like creating tables and adding columns.
 *
 * Observers use the DatabaseDialect from context to generate appropriate SQL:
 * - DdlCreateModel (10): CREATE TABLE for new models
 * - DdlCreateField (10): ALTER TABLE ADD COLUMN for new fields
 *
 * @module ems/ring/6
 */

export { DdlCreateModel } from './10-ddl-create-model.js';
export { DdlCreateField } from './10-ddl-create-field.js';
