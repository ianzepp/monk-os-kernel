# Describe API

The Describe API provides model definition and management capabilities using Monk-native format with direct PostgreSQL type mapping. Create, update, and manage database table structures with field-level precision.

## Base Path
All Describe API routes are prefixed with `/api/describe`

## Endpoint Summary

### Model Operations

| Method | Path | Description |
|--------|------|-------------|
| GET | [`/api/describe`](GET.md) | List all available model names |
| GET | [`/api/describe/:model`](:model/GET.md) | Retrieve model metadata |
| POST | [`/api/describe/:model`](:model/POST.md) | Create a new model |
| PUT | [`/api/describe/:model`](:model/PUT.md) | Update model metadata |
| DELETE | [`/api/describe/:model`](:model/DELETE.md) | Soft-delete a model |

### Field Operations

| Method | Path | Description |
|--------|------|-------------|
| GET | [`/api/describe/:model/fields`](:model/fields/GET.md) | List all fields in model |
| POST | [`/api/describe/:model/fields`](:model/fields/POST.md) | **Bulk create** multiple fields |
| PUT | [`/api/describe/:model/fields`](:model/fields/PUT.md) | **Bulk update** multiple fields |
| GET | [`/api/describe/:model/fields/:field`](:model/fields/:field/GET.md) | Retrieve field definition |
| POST | [`/api/describe/:model/fields/:field`](:model/fields/:field/POST.md) | Add a single field to model |
| PUT | [`/api/describe/:model/fields/:field`](:model/fields/:field/PUT.md) | Update single field properties |
| DELETE | [`/api/describe/:model/fields/:field`](:model/fields/:field/DELETE.md) | Remove field from model |

## Content Type
- **Request**: `application/json`
- **Response**: `application/json`

## Authentication Required
All endpoints require a valid JWT token in the Authorization header: `Bearer <token>`

---

## Quick Start

### Creating a Model with Fields (Recommended)

Use bulk field creation for efficiency - one request instead of many:

```bash
# Step 1: Create model
curl -X POST http://localhost:9001/api/describe/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "pending"}'

# Step 2: Add ALL fields in one request
curl -X POST http://localhost:9001/api/describe/users/fields \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '[
    {"field_name": "name", "type": "text", "required": true, "description": "User full name"},
    {"field_name": "email", "type": "text", "required": true, "unique": true, "index": true, "pattern": "^[^@]+@[^@]+\\.[^@]+$"},
    {"field_name": "age", "type": "integer", "minimum": 0, "maximum": 150},
    {"field_name": "is_active", "type": "boolean", "default_value": true}
  ]'

# Step 3: Activate model
curl -X PUT http://localhost:9001/api/describe/users \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"status": "active"}'
```

### Adding a Single Field

For adding individual fields to an existing model:

```bash
curl -X POST http://localhost:9001/api/describe/users/fields/phone \
  -H "Authorization: Bearer YOUR_JWT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "type": "text",
    "transform": "normalize_phone",
    "description": "Phone number"
  }'
```

---

## Model Reference

### Model Fields

All fields available when creating or updating models:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `model_name` | text | Yes | - | Unique identifier for the model. Must match URL parameter. |
| `status` | text | No | `pending` | Model status: `pending`, `active`, or `system`. |
| `description` | text | No | - | Human-readable description of the model's purpose. |
| `sudo` | boolean | No | `false` | Require sudo token for all data operations on this model. |
| `freeze` | boolean | No | `false` | Prevent all data changes (create, update, delete). SELECT still works. |
| `immutable` | boolean | No | `false` | Records are write-once: can be created but never modified. |

**Notes:**
- System fields (id, timestamps, access_*) are automatically added to all tables
- `model_name` must be a valid PostgreSQL identifier (alphanumeric and underscores)
- Models with `status='system'` cannot be modified or deleted

### Field Fields

All fields available when creating or updating fields:

| Field | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| **Identity** |
| `type` | text | Yes | - | Data type: `text`, `integer`, `decimal`, `boolean`, `timestamp`, `date`, `uuid`, `jsonb`, or array types. See [type mapping](#postgresql-type-mapping). |
| **Constraints** |
| `required` | boolean | No | `false` | Whether the field is required (NOT NULL constraint). |
| `default_value` | text | No | - | Default value for the field. |
| `unique` | boolean | No | `false` | Whether the field must have unique values. Creates UNIQUE index. |
| **Validation** |
| `minimum` | numeric | No | - | Minimum value for numeric types. Application-level validation. |
| `maximum` | numeric | No | - | Maximum value for numeric types or max length for text. |
| `pattern` | text | No | - | Regular expression pattern for text validation. |
| `enum_values` | text[] | No | - | Array of allowed values. Application-level validation. |
| **Metadata** |
| `description` | text | No | - | Human-readable description of the field's purpose. |
| **Protection** |
| `immutable` | boolean | No | `false` | Value can be set once but never changed. Perfect for audit trails. |
| `sudo` | boolean | No | `false` | Require sudo token to modify this field. |
| **Indexing & Search** |
| `index` | boolean | No | `false` | Create standard btree index on this field for faster queries. |
| `searchable` | boolean | No | `false` | Enable full-text search with GIN index. For text fields only. |
| **Change Tracking** |
| `tracked` | boolean | No | `false` | Track changes to this field in the `history` table. |
| **Data Transform** |
| `transform` | text | No | - | Auto-transform values: `lowercase`, `uppercase`, `trim`, `normalize_phone`, `normalize_email`. |
| **Relationships** |
| `relationship_type` | text | No | - | Type of relationship: `owned` or `referenced`. |
| `related_model` | text | No | - | Target model for the relationship. |
| `related_field` | text | No | `id` | Target field for the relationship (usually `id`). |
| `relationship_name` | text | No | - | Name of the relationship for API access. |
| `cascade_delete` | boolean | No | `false` | Whether to cascade delete when parent is deleted. |
| `required_relationship` | boolean | No | `false` | Whether the relationship is required (NOT NULL FK). |

**Notes:**
- `model_name` and `field_name` come from URL parameters, not request body
- **Structural changes** (trigger ALTER TABLE): `type`, `required`, `default_value`, `unique`, `index`, `searchable`
- **Metadata-only**: `description`, `pattern`, `minimum`, `maximum`, `enum_values`, `immutable`, `sudo`, `tracked`, `transform`
- Field names must start with a letter or underscore, followed by alphanumerics/underscores

---

## PostgreSQL Type Mapping

User-facing types are mapped to PostgreSQL types internally:

| User Type | PostgreSQL Type | Use Case |
|-----------|-----------------|----------|
| `text` | TEXT | General strings |
| `integer` | INTEGER | Whole numbers |
| `decimal` | NUMERIC | Precise decimals, currency |
| `boolean` | BOOLEAN | True/false values |
| `timestamp` | TIMESTAMP WITH TIME ZONE | Date and time with timezone |
| `date` | DATE | Date only |
| `uuid` | UUID | Unique identifiers |
| `jsonb` | JSONB | JSON data structures |
| `text[]` | TEXT[] | Array of strings |
| `integer[]` | INTEGER[] | Array of integers |
| `decimal[]` | NUMERIC[] | Array of decimals |
| `uuid[]` | UUID[] | Array of UUIDs |

**Note:** Use user-facing types (e.g., `decimal`) in API requests. The system automatically maps them to appropriate PostgreSQL types (e.g., `NUMERIC`).

## System Fields

All models automatically include system-managed fields:

| Field | Type | Purpose |
|-------|------|---------|
| `id` | UUID | Primary key (auto-generated) |
| `access_read` | UUID[] | Read access control list |
| `access_edit` | UUID[] | Edit access control list |
| `access_full` | UUID[] | Full access control list |
| `access_deny` | UUID[] | Deny access control list |
| `created_at` | TIMESTAMP | Record creation time |
| `updated_at` | TIMESTAMP | Last modification time |
| `trashed_at` | TIMESTAMP | Soft delete timestamp |
| `deleted_at` | TIMESTAMP | Hard delete timestamp |

**Do not define these fields in your models** - they are automatically added.

## Model Protection Features

### System Model Protection
System models (`status='system'`) cannot be modified or deleted:
- `models` - Model metadata registry
- `users` - User account management
- `fields` - Field metadata table
- `history` - Change tracking and audit trails

### Sudo-Protected Models
Models marked with `sudo=true` require a short-lived sudo token for all data operations. Users must call `POST /api/user/sudo` to obtain the token before modifying these models.

**Use case**: Protect critical system models from accidental modifications.

### Frozen Models
Models marked with `freeze=true` prevent ALL data changes (create, update, delete). SELECT operations continue to work normally.

**Use cases**:
- Emergency lockdowns during security incidents
- Maintenance windows requiring read-only access
- Regulatory compliance freeze periods

### Immutable Models
Models marked with `immutable=true` allow records to be created but never modified or deleted. Write-once data pattern.

**Use cases**:
- Audit logs and compliance trails that must never change
- Transaction history and financial records
- Event logs and time-series data
- Append-only ledgers

**Note:** Unlike `freeze`, immutable models still allow INSERT operations. Only UPDATE and DELETE are prevented.

### Field-Level Protection

**Immutable Fields**: Fields marked with `immutable=true` can be set once but never changed. Perfect for audit trails and write-once data like transaction IDs.

**Sudo-Protected Fields**: Fields marked with `sudo=true` require a sudo token to modify, even if the model itself doesn't require sudo. Allows fine-grained protection of sensitive fields like salary or pricing information.

## Related Documentation

- **Data Operations**: `/docs/data` - CRUD operations on model records
- **Bulk Operations**: `/docs/bulk` - Batch operations across models
- **Advanced Search**: `/docs/find` - Complex queries with filtering
- **History API**: `/docs/history` - Change tracking and audit trails

The Describe API provides the foundation for all data operations by defining database structure with Monk-native format and direct PostgreSQL mapping.
