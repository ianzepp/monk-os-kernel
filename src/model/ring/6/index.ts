/**
 * Ring 6: Post-Database (DDL)
 *
 * These observers run after Ring 5 (database operations) and handle
 * schema changes like creating tables and adding columns.
 *
 * Observers in this ring:
 * - DdlCreateModel (10): CREATE TABLE when model is created
 * - DdlCreateField (10): ALTER TABLE ADD COLUMN when field is created
 *
 * @module model/ring/6
 */

export { DdlCreateModel } from './10-ddl-create-model.js';
export { DdlCreateField } from './10-ddl-create-field.js';
