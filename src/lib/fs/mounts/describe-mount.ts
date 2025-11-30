/**
 * DescribeMount - Model schemas as filesystem
 *
 * Matches HTTP API structure:
 * - /api/describe/                       → GET /api/describe (list models)
 * - /api/describe/users/                 → GET /api/describe/:model (model dir)
 * - /api/describe/users/.yaml            → Full model schema as YAML (hidden)
 * - /api/describe/users/.json            → Full model schema as JSON (hidden)
 * - /api/describe/users/fields/          → GET /api/describe/:model/fields (list fields)
 * - /api/describe/users/fields/name      → GET /api/describe/:model/fields/:field
 *
 * Read-only mount. Model modifications go through /api/data/models.
 */

import yaml from 'js-yaml';
import type { System } from '@src/lib/system.js';
import type { Mount, FSEntry } from '../types.js';
import { FSError } from '../types.js';
import { stripSystemFields } from '@src/lib/describe.js';

type ParsedPath =
    | { type: 'root' }
    | { type: 'model'; modelName: string }
    | { type: 'schema'; modelName: string; format: 'yaml' | 'json' }
    | { type: 'fields'; modelName: string }
    | { type: 'field'; modelName: string; fieldName: string };

export class DescribeMount implements Mount {
    constructor(private readonly system: System) {}

    async stat(path: string): Promise<FSEntry> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root') {
            return {
                name: 'describe',
                type: 'directory',
                size: 0,
                mode: 0o755,
            };
        }

        if (parsed.type === 'model') {
            const model = await this.system.describe.models.selectOne({
                where: { model_name: parsed.modelName },
            });
            if (!model) {
                throw new FSError('ENOENT', path);
            }
            return {
                name: parsed.modelName,
                type: 'directory',
                size: 0,
                mode: 0o755,
                mtime: model.updated_at ? new Date(model.updated_at) : undefined,
            };
        }

        if (parsed.type === 'schema') {
            const model = await this.system.describe.models.selectOne({
                where: { model_name: parsed.modelName },
            });
            if (!model) {
                throw new FSError('ENOENT', path);
            }
            const content = await this.getModelSchema(parsed.modelName, parsed.format);
            return {
                name: `.${parsed.format}`,
                type: 'file',
                size: Buffer.byteLength(content, 'utf8'),
                mode: 0o644,
                mtime: model.updated_at ? new Date(model.updated_at) : undefined,
            };
        }

        if (parsed.type === 'fields') {
            const model = await this.system.describe.models.selectOne({
                where: { model_name: parsed.modelName },
            });
            if (!model) {
                throw new FSError('ENOENT', path);
            }
            return {
                name: 'fields',
                type: 'directory',
                size: 0,
                mode: 0o755,
            };
        }

        if (parsed.type === 'field') {
            const field = await this.system.describe.fields.selectOne({
                where: { model_name: parsed.modelName, field_name: parsed.fieldName },
            });
            if (!field) {
                throw new FSError('ENOENT', path);
            }
            const content = yaml.dump(stripSystemFields({ ...field }), { indent: 2 });
            return {
                name: parsed.fieldName,
                type: 'file',
                size: Buffer.byteLength(content, 'utf8'),
                mode: 0o644,
                mtime: field.updated_at ? new Date(field.updated_at) : undefined,
            };
        }

        throw new FSError('ENOENT', path);
    }

    async readdir(path: string): Promise<FSEntry[]> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root') {
            const models = await this.system.describe.models.selectAny();
            return models.map(m => ({
                name: m.model_name,
                type: 'directory' as const,
                size: 0,
                mode: 0o755,
                mtime: m.updated_at ? new Date(m.updated_at) : undefined,
            }));
        }

        if (parsed.type === 'model') {
            const model = await this.system.describe.models.selectOne({
                where: { model_name: parsed.modelName },
            });
            if (!model) {
                throw new FSError('ENOENT', path);
            }

            return [
                { name: '.yaml', type: 'file', size: 0, mode: 0o644 },
                { name: '.json', type: 'file', size: 0, mode: 0o644 },
                { name: 'fields', type: 'directory', size: 0, mode: 0o755 },
            ];
        }

        if (parsed.type === 'fields') {
            const model = await this.system.describe.models.selectOne({
                where: { model_name: parsed.modelName },
            });
            if (!model) {
                throw new FSError('ENOENT', path);
            }

            const fields = await this.system.describe.fields.selectAny({
                where: { model_name: parsed.modelName },
            });

            return fields.map(field => ({
                name: field.field_name,
                type: 'file' as const,
                size: 0,
                mode: 0o644,
                mtime: field.updated_at ? new Date(field.updated_at) : undefined,
            }));
        }

        throw new FSError('ENOTDIR', path);
    }

    async read(path: string): Promise<string> {
        const parsed = this.parsePath(path);

        if (parsed.type === 'root' || parsed.type === 'model' || parsed.type === 'fields') {
            throw new FSError('EISDIR', path);
        }

        if (parsed.type === 'schema') {
            const model = await this.system.describe.models.selectOne({
                where: { model_name: parsed.modelName },
            });
            if (!model) {
                throw new FSError('ENOENT', path);
            }
            return this.getModelSchema(parsed.modelName, parsed.format);
        }

        if (parsed.type === 'field') {
            const field = await this.system.describe.fields.selectOne({
                where: { model_name: parsed.modelName, field_name: parsed.fieldName },
            });
            if (!field) {
                throw new FSError('ENOENT', path);
            }
            return yaml.dump(stripSystemFields({ ...field }), { indent: 2, lineWidth: 120 });
        }

        throw new FSError('ENOENT', path);
    }

    private async getModelSchema(modelName: string, format: 'yaml' | 'json'): Promise<string> {
        const model = await this.system.describe.models.selectOne({
            where: { model_name: modelName },
        });
        if (!model) {
            throw new FSError('ENOENT', `/${modelName}/.${format}`);
        }

        const fields = await this.system.describe.fields.selectAny({
            where: { model_name: modelName },
        });

        const schema = {
            ...stripSystemFields({ ...model }),
            fields: stripSystemFields([...fields]),
        };

        if (format === 'json') {
            return JSON.stringify(schema, null, 2);
        }
        return yaml.dump(schema, { indent: 2, lineWidth: 120 });
    }

    private parsePath(path: string): ParsedPath {
        const segments = path.split('/').filter(Boolean);

        if (segments.length === 0) {
            return { type: 'root' };
        }

        if (segments.length === 1) {
            return { type: 'model', modelName: segments[0] };
        }

        if (segments.length === 2) {
            const [modelName, second] = segments;

            if (second === '.yaml' || second === '.yml') {
                return { type: 'schema', modelName, format: 'yaml' };
            }
            if (second === '.json') {
                return { type: 'schema', modelName, format: 'json' };
            }
            if (second === 'fields') {
                return { type: 'fields', modelName };
            }
        }

        if (segments.length === 3 && segments[1] === 'fields') {
            return { type: 'field', modelName: segments[0], fieldName: segments[2] };
        }

        throw new FSError('ENOENT', path);
    }
}
