/**
 * LLM Adapters
 *
 * Factory for selecting provider-specific adapters based on api_format.
 *
 * @module llm/adapters
 */

import type { Adapter } from './types.js';
import type { ApiFormat } from '../types.js';
import { OpenAIAdapter } from './openai.js';
import { AnthropicAdapter } from './anthropic.js';

// =============================================================================
// ADAPTER REGISTRY
// =============================================================================

/**
 * Singleton adapter instances.
 *
 * WHY singletons: Adapters are stateless - they just translate formats.
 * No need to create new instances per request.
 */
const adapters: Record<ApiFormat, Adapter> = {
    openai: new OpenAIAdapter(),
    anthropic: new AnthropicAdapter(),
};

// =============================================================================
// FACTORY
// =============================================================================

/**
 * Get adapter for a given API format.
 *
 * @param format - API format ('openai' or 'anthropic')
 * @returns Adapter instance
 * @throws Error if format is unsupported
 */
export function getAdapter(format: ApiFormat): Adapter {
    const adapter = adapters[format];

    if (!adapter) {
        throw new Error(`Unsupported API format: ${format}`);
    }

    return adapter;
}

// =============================================================================
// EXPORTS
// =============================================================================

export type { Adapter } from './types.js';
export { OpenAIAdapter } from './openai.js';
export { AnthropicAdapter } from './anthropic.js';
