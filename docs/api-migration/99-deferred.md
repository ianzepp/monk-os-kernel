# Deferred Work

This document tracks API migration work that has been deferred indefinitely. These features are fully designed but not prioritized for immediate implementation.

## Phase 5: Model Loader (DEFERRED)

**Original Goal:** Load YAML/JSON model definitions at boot time

**Why Deferred:** System models are already seeded via schema.sql. User-defined models can be created programmatically via DatabaseOps. YAML/JSON loading adds complexity without immediate value.

**What Works Today:**
- Models created via `DatabaseOps.createAll('models', [...])`
- Fields created via `DatabaseOps.createAll('fields', [...])`
- DDL observers automatically create tables/columns
- Schema.sql seeds system models (file, folder, device, proc, link)

**Future Implementation:**
When needed, implement:
- YAML/JSON parser for model definitions
- Validation of model/field definitions
- Boot-time loading from `/etc/models` and `/app/models`
- VFS integration for loading from filesystem

See original design: [05-model-loader.md](./05-model-loader.md)

---

## Phase 7: Query API (OPTIONAL)

**Original Goal:** Rich query interface beyond path access

**Why Deferred:** Direct SQL queries via DatabaseConnection work for current needs. A query builder adds abstraction without clear benefit yet.

**What Works Today:**
- `db.query<T>(sql, params)` for SELECT queries
- `db.execute(sql, params)` for mutations
- Full SQLite query capability

**Future Implementation:**
When needed, implement:
- Filter class for query building
- Expose query via syscall or special path
- Support aggregations (count, sum, etc.)

See original design: [07-query-api.md](./07-query-api.md) (if exists)

---

## Additional Future Enhancements

### Ring 2: Security Observers
- Permission validation
- Existence checks
- Soft-delete protection

### Ring 3: Business Logic Observers
- Cross-field validation
- Custom business rules
- Application-specific observers

### Ring 9: Notification Observers
- Internal events
- Pub/sub notifications
- Triggers

### Relationship Validation
- Validate foreign key references exist
- Cascade delete enforcement
- Relationship integrity checks

### Full-Text Search
- Use `searchable: true` fields
- SQLite FTS5 integration
- Search via special query syntax
