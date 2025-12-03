# Phase 5: Model Loader

## Overview

The model loader parses YAML/JSON model definitions and inserts them into the `models` and `fields` tables. This enables developers to define their data model declaratively.

## Model Definition Format

### YAML Format

```yaml
# /app/models/invoice.yaml
name: invoice
description: Customer invoices
status: active

# Model-level flags (optional)
sudo: false
frozen: false
immutable: false

fields:
  - name: number
    type: text
    required: true
    unique: true
    immutable: true
    description: Invoice number (auto-generated)

  - name: customer_id
    type: uuid
    required: true
    relationship:
      type: referenced
      model: customer
      name: customer

  - name: line_items
    type: jsonb
    required: true
    description: Array of line item objects

  - name: subtotal
    type: numeric
    minimum: 0

  - name: tax
    type: numeric
    minimum: 0
    default: 0

  - name: total
    type: numeric
    minimum: 0
    required: true

  - name: status
    type: text
    required: true
    default: draft
    enum:
      - draft
      - sent
      - paid
      - cancelled
    tracked: true

  - name: notes
    type: text
    searchable: true

  - name: created_by
    type: uuid
    immutable: true
```

### JSON Format

```json
{
  "name": "invoice",
  "description": "Customer invoices",
  "fields": [
    {
      "name": "number",
      "type": "text",
      "required": true,
      "unique": true,
      "immutable": true
    },
    {
      "name": "status",
      "type": "text",
      "required": true,
      "default": "draft",
      "enum": ["draft", "sent", "paid", "cancelled"],
      "tracked": true
    }
  ]
}
```

## Loader Implementation

### Types (`src/model/loader/types.ts`)

```typescript
/**
 * Model definition as parsed from YAML/JSON
 */
export interface ModelDefinition {
    name: string;
    description?: string;
    status?: 'active' | 'disabled';

    // Behavioral flags
    sudo?: boolean;
    frozen?: boolean;
    immutable?: boolean;
    external?: boolean;
    passthrough?: boolean;

    // Field definitions
    fields: FieldDefinition[];
}

/**
 * Field definition as parsed from YAML/JSON
 */
export interface FieldDefinition {
    name: string;
    type: FieldType;
    description?: string;

    // Constraints
    required?: boolean;
    default?: unknown;
    minimum?: number;
    maximum?: number;
    pattern?: string;
    enum?: string[];

    // Behavioral flags
    immutable?: boolean;
    sudo?: boolean;
    unique?: boolean;
    index?: boolean;
    tracked?: boolean;
    searchable?: boolean;
    transform?: TransformType;

    // Relationships
    relationship?: {
        type: 'owned' | 'referenced';
        model: string;
        field?: string;
        name?: string;
        cascade_delete?: boolean;
        required?: boolean;
    };
}

export type FieldType =
    | 'text'
    | 'integer'
    | 'numeric'
    | 'boolean'
    | 'uuid'
    | 'timestamp'
    | 'date'
    | 'jsonb'
    | 'binary'
    | 'text[]'
    | 'integer[]'
    | 'uuid[]';

export type TransformType =
    | 'lowercase'
    | 'uppercase'
    | 'trim'
    | 'normalize_email'
    | 'normalize_phone';
```

### Parser (`src/model/loader/parser.ts`)

```typescript
import { parse as parseYaml } from 'yaml';
import type { ModelDefinition, FieldDefinition } from './types';

/**
 * Parse model definition from file content
 */
export function parseModelDefinition(
    content: string,
    format: 'yaml' | 'json'
): ModelDefinition {
    const raw = format === 'yaml'
        ? parseYaml(content)
        : JSON.parse(content);

    return validateModelDefinition(raw);
}

/**
 * Validate and normalize model definition
 */
function validateModelDefinition(raw: unknown): ModelDefinition {
    if (!raw || typeof raw !== 'object') {
        throw new Error('Model definition must be an object');
    }

    const obj = raw as Record<string, unknown>;

    if (!obj.name || typeof obj.name !== 'string') {
        throw new Error('Model must have a name');
    }

    if (!obj.fields || !Array.isArray(obj.fields)) {
        throw new Error('Model must have fields array');
    }

    return {
        name: obj.name,
        description: obj.description as string | undefined,
        status: (obj.status as 'active' | 'disabled') || 'active',
        sudo: Boolean(obj.sudo),
        frozen: Boolean(obj.frozen),
        immutable: Boolean(obj.immutable),
        external: Boolean(obj.external),
        passthrough: Boolean(obj.passthrough),
        fields: obj.fields.map(validateFieldDefinition),
    };
}

/**
 * Validate and normalize field definition
 */
function validateFieldDefinition(raw: unknown, index: number): FieldDefinition {
    if (!raw || typeof raw !== 'object') {
        throw new Error(`Field ${index} must be an object`);
    }

    const obj = raw as Record<string, unknown>;

    if (!obj.name || typeof obj.name !== 'string') {
        throw new Error(`Field ${index} must have a name`);
    }

    // Validate field name format
    if (!/^[a-z_][a-z0-9_]*$/.test(obj.name)) {
        throw new Error(
            `Field name '${obj.name}' must start with lowercase letter or underscore, ` +
            `contain only lowercase letters, digits, and underscores`
        );
    }

    // Check for reserved names
    const reserved = ['id', 'created_at', 'updated_at', 'trashed_at', 'expired_at'];
    if (reserved.includes(obj.name)) {
        throw new Error(`Field name '${obj.name}' is reserved`);
    }

    return {
        name: obj.name,
        type: (obj.type as FieldDefinition['type']) || 'text',
        description: obj.description as string | undefined,
        required: Boolean(obj.required),
        default: obj.default,
        minimum: obj.minimum as number | undefined,
        maximum: obj.maximum as number | undefined,
        pattern: obj.pattern as string | undefined,
        enum: obj.enum as string[] | undefined,
        immutable: Boolean(obj.immutable),
        sudo: Boolean(obj.sudo),
        unique: Boolean(obj.unique),
        index: Boolean(obj.index),
        tracked: Boolean(obj.tracked),
        searchable: Boolean(obj.searchable),
        transform: obj.transform as FieldDefinition['transform'],
        relationship: obj.relationship as FieldDefinition['relationship'],
    };
}
```

### Loader (`src/model/loader/loader.ts`)

```typescript
import { parseModelDefinition } from './parser';
import type { ModelDefinition } from './types';
import type { DatabaseService } from '../database';

/**
 * Load model definitions into the database
 */
export class ModelLoader {
    constructor(private db: DatabaseService) {}

    /**
     * Load a single model definition
     */
    async loadModel(definition: ModelDefinition): Promise<void> {
        // Check if model already exists
        const existing = this.db.selectOne('models', {
            model_name: definition.name,
        });

        if (existing) {
            console.log(`Model '${definition.name}' already exists, updating...`);
            await this.updateModel(definition, existing.id);
        } else {
            console.log(`Creating model '${definition.name}'...`);
            await this.createModel(definition);
        }
    }

    /**
     * Load model definitions from a directory
     */
    async loadDirectory(path: string): Promise<void> {
        const { readdir, readFile } = await import('fs/promises');
        const { join, extname } = await import('path');

        const files = await readdir(path);

        for (const file of files) {
            const ext = extname(file).toLowerCase();
            if (ext !== '.yaml' && ext !== '.yml' && ext !== '.json') {
                continue;
            }

            const content = await readFile(join(path, file), 'utf-8');
            const format = ext === '.json' ? 'json' : 'yaml';

            try {
                const definition = parseModelDefinition(content, format);
                await this.loadModel(definition);
            } catch (error) {
                console.error(`Failed to load ${file}:`, error);
                throw error;
            }
        }
    }

    /**
     * Load from VFS path (for OS integration)
     */
    async loadFromVfs(vfsPath: string, vfs: any): Promise<void> {
        // Read directory listing from VFS
        const entries: string[] = [];
        for await (const entry of vfs.list(vfsPath)) {
            entries.push(entry.name);
        }

        for (const name of entries) {
            const ext = name.split('.').pop()?.toLowerCase();
            if (ext !== 'yaml' && ext !== 'yml' && ext !== 'json') {
                continue;
            }

            const content = await vfs.readFile(`${vfsPath}/${name}`);
            const text = new TextDecoder().decode(content);
            const format = ext === 'json' ? 'json' : 'yaml';

            try {
                const definition = parseModelDefinition(text, format);
                await this.loadModel(definition);
            } catch (error) {
                console.error(`Failed to load ${name}:`, error);
                throw error;
            }
        }
    }

    private async createModel(definition: ModelDefinition): Promise<void> {
        // Create model record (triggers ModelDdlCreate observer)
        await this.db.createOne('models', {
            model_name: definition.name,
            description: definition.description,
            status: definition.status || 'active',
            sudo: definition.sudo || false,
            frozen: definition.frozen || false,
            immutable: definition.immutable || false,
            external: definition.external || false,
            passthrough: definition.passthrough || false,
        });

        // Create field records (triggers FieldDdlCreate observer for each)
        for (const field of definition.fields) {
            await this.createField(definition.name, field);
        }
    }

    private async updateModel(
        definition: ModelDefinition,
        modelId: string
    ): Promise<void> {
        // Update model metadata
        await this.db.updateOne('models', modelId, {
            description: definition.description,
            status: definition.status || 'active',
            sudo: definition.sudo || false,
            frozen: definition.frozen || false,
            immutable: definition.immutable || false,
        });

        // Get existing fields
        const existingFields = this.db.selectAny('fields', {
            model_name: definition.name,
        });
        const existingByName = new Map(
            existingFields.map(f => [f.field_name, f])
        );

        // Create or update fields
        for (const field of definition.fields) {
            const existing = existingByName.get(field.name);
            if (existing) {
                await this.updateField(existing.id, field);
                existingByName.delete(field.name);
            } else {
                await this.createField(definition.name, field);
            }
        }

        // Note: We don't delete fields that are no longer in the definition
        // That would be destructive. Log a warning instead.
        for (const [name] of existingByName) {
            console.warn(
                `Field '${name}' exists in database but not in definition for model '${definition.name}'`
            );
        }
    }

    private async createField(modelName: string, field: any): Promise<void> {
        await this.db.createOne('fields', {
            model_name: modelName,
            field_name: field.name,
            type: field.type || 'text',
            is_array: field.type?.endsWith('[]') || false,
            required: field.required || false,
            default_value: field.default !== undefined
                ? String(field.default)
                : null,
            minimum: field.minimum ?? null,
            maximum: field.maximum ?? null,
            pattern: field.pattern ?? null,
            enum_values: field.enum ? JSON.stringify(field.enum) : null,
            immutable: field.immutable || false,
            sudo: field.sudo || false,
            unique_: field.unique || false,
            index_: field.index || false,
            tracked: field.tracked || false,
            searchable: field.searchable || false,
            transform: field.transform ?? null,
            relationship_type: field.relationship?.type ?? null,
            related_model: field.relationship?.model ?? null,
            related_field: field.relationship?.field ?? null,
            relationship_name: field.relationship?.name ?? null,
            cascade_delete: field.relationship?.cascade_delete || false,
            required_relationship: field.relationship?.required || false,
            description: field.description ?? null,
        });
    }

    private async updateField(fieldId: string, field: any): Promise<void> {
        await this.db.updateOne('fields', fieldId, {
            type: field.type || 'text',
            is_array: field.type?.endsWith('[]') || false,
            required: field.required || false,
            default_value: field.default !== undefined
                ? String(field.default)
                : null,
            minimum: field.minimum ?? null,
            maximum: field.maximum ?? null,
            pattern: field.pattern ?? null,
            enum_values: field.enum ? JSON.stringify(field.enum) : null,
            immutable: field.immutable || false,
            sudo: field.sudo || false,
            unique_: field.unique || false,
            index_: field.index || false,
            tracked: field.tracked || false,
            searchable: field.searchable || false,
            transform: field.transform ?? null,
            description: field.description ?? null,
            // Note: Relationship changes would need careful handling
        });
    }
}
```

## Boot Integration

### Loading at OS Boot

```typescript
// In OS boot sequence (src/os/os.ts or similar)

import { ModelLoader } from '../model/loader/loader';

// After database and VFS are initialized...
async function loadModels(db: DatabaseService, vfs: VFS): Promise<void> {
    const loader = new ModelLoader(db);

    // Load from /etc/models (system models)
    try {
        await loader.loadFromVfs('/etc/models', vfs);
    } catch (error) {
        console.warn('No system models found in /etc/models');
    }

    // Load from /app/models (application models)
    try {
        await loader.loadFromVfs('/app/models', vfs);
    } catch (error) {
        console.warn('No application models found in /app/models');
    }
}
```

### Configuration Option

```typescript
interface OSConfig {
    // ... existing config ...

    /**
     * Paths to load model definitions from
     * Default: ['/etc/models', '/app/models']
     */
    modelPaths?: string[];
}
```

## Directory Structure

```
src/model/
├── loader/
│   ├── types.ts       # ModelDefinition, FieldDefinition types
│   ├── parser.ts      # YAML/JSON parsing
│   └── loader.ts      # ModelLoader class
├── observers/         # (Phase 1 - IMPLEMENTED)
├── model.ts           # (Phase 3)
├── model-record.ts    # (Phase 3)
├── model-cache.ts     # (Phase 3)
├── database.ts        # (Phase 3)
├── context.ts         # (Phase 3)
└── schema.sql         # (Phase 2)
```

## Example Usage

### Defining Models

```yaml
# /app/models/customer.yaml
name: customer
description: Customer records

fields:
  - name: name
    type: text
    required: true
    searchable: true

  - name: email
    type: text
    required: true
    unique: true
    transform: normalize_email

  - name: phone
    type: text
    transform: normalize_phone

  - name: status
    type: text
    default: active
    enum: [active, inactive, suspended]
```

```yaml
# /app/models/order.yaml
name: order
description: Customer orders

fields:
  - name: customer_id
    type: uuid
    required: true
    relationship:
      type: referenced
      model: customer
      name: customer

  - name: order_date
    type: timestamp
    required: true
    immutable: true

  - name: status
    type: text
    default: pending
    enum: [pending, confirmed, shipped, delivered, cancelled]
    tracked: true

  - name: total
    type: numeric
    required: true
    minimum: 0
```

### Loading Programmatically

```typescript
import { createDbContext, createDatabase } from './model/context';
import { ModelLoader } from './model/loader/loader';
import { parseModelDefinition } from './model/loader/parser';

const ctx = createDbContext();
const db = createDatabase(ctx);
const loader = new ModelLoader(db);

// Load from YAML string
const yaml = `
name: task
fields:
  - name: title
    type: text
    required: true
  - name: done
    type: boolean
    default: false
`;

const definition = parseModelDefinition(yaml, 'yaml');
await loader.loadModel(definition);

// Now can use the model
await db.createOne('task', { title: 'Hello world' });
```

## Acceptance Criteria

- [ ] Can parse YAML model definitions
- [ ] Can parse JSON model definitions
- [ ] Validates model name format
- [ ] Validates field name format
- [ ] Rejects reserved field names (id, created_at, etc.)
- [ ] Creates model record in models table
- [ ] Creates field records in fields table
- [ ] DDL observers create actual table/columns
- [ ] Can load from directory
- [ ] Can load from VFS path
- [ ] Handles model updates (add fields, change metadata)
- [ ] Warns about removed fields (doesn't delete)

## Next Phase

Once model loader is complete, proceed to [Phase 5.5: Entity Cache](./05.5-entity-cache.md) to build the in-memory entity index for O(1) path resolution.
