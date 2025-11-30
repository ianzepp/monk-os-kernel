/**
 * Environment Device
 *
 * Boot-time environment variables and configuration.
 *
 * Bun touchpoints:
 * - Bun.env for environment access
 * - process.env as alternative (same object)
 *
 * Caveats:
 * - Environment is inherited from host process at start
 * - Changes via set() affect the current process only
 * - Child processes inherit env at spawn time, not live updates
 * - Deleting a variable: set(key, '') vs delete not standardized
 */

/**
 * Environment device interface.
 */
export interface EnvDevice {
    /**
     * Get environment variable.
     *
     * Bun: Bun.env[key]
     *
     * @param key - Variable name
     * @returns Value or undefined if not set
     */
    get(key: string): string | undefined;

    /**
     * Set environment variable.
     *
     * Bun: Bun.env[key] = value
     *
     * Caveat: Only affects current process. Child processes
     * spawned after this call will inherit the new value.
     *
     * @param key - Variable name
     * @param value - Variable value
     */
    set(key: string, value: string): void;

    /**
     * Delete environment variable.
     *
     * Bun: delete Bun.env[key]
     *
     * @param key - Variable name
     */
    unset(key: string): void;

    /**
     * Check if environment variable is set.
     *
     * @param key - Variable name
     */
    has(key: string): boolean;

    /**
     * Get all environment variables.
     *
     * Bun: { ...Bun.env }
     *
     * @returns Copy of environment (modifications don't affect actual env)
     */
    list(): Record<string, string>;
}

/**
 * Bun environment device implementation
 *
 * Bun touchpoints:
 * - Bun.env is a Proxy over process.env
 * - Accessing undefined keys returns undefined (not throwing)
 *
 * Caveats:
 * - Bun.env values are always strings (or undefined)
 * - Some special vars (PATH, HOME) have OS-specific behavior
 */
export class BunEnvDevice implements EnvDevice {
    get(key: string): string | undefined {
        return Bun.env[key];
    }

    set(key: string, value: string): void {
        Bun.env[key] = value;
    }

    unset(key: string): void {
        delete Bun.env[key];
    }

    has(key: string): boolean {
        return key in Bun.env;
    }

    list(): Record<string, string> {
        // Create a plain object copy (Bun.env is a Proxy)
        const result: Record<string, string> = {};
        for (const key in Bun.env) {
            const value = Bun.env[key];
            if (value !== undefined) {
                result[key] = value;
            }
        }
        return result;
    }
}

/**
 * Mock environment device for testing
 *
 * Provides isolated environment that doesn't affect process.env.
 *
 * Usage:
 *   const env = new MockEnvDevice({ HOME: '/home/test' });
 *   env.get('HOME'); // '/home/test'
 *   env.set('FOO', 'bar');
 *   env.reset(); // Back to initial state
 */
export class MockEnvDevice implements EnvDevice {
    private env: Map<string, string>;
    private initial: Map<string, string>;

    constructor(initialEnv?: Record<string, string>) {
        this.initial = new Map(Object.entries(initialEnv ?? {}));
        this.env = new Map(this.initial);
    }

    get(key: string): string | undefined {
        return this.env.get(key);
    }

    set(key: string, value: string): void {
        this.env.set(key, value);
    }

    unset(key: string): void {
        this.env.delete(key);
    }

    has(key: string): boolean {
        return this.env.has(key);
    }

    list(): Record<string, string> {
        const result: Record<string, string> = {};
        for (const [key, value] of this.env) {
            result[key] = value;
        }
        return result;
    }

    /**
     * Reset to initial state.
     */
    reset(): void {
        this.env = new Map(this.initial);
    }

    /**
     * Replace all variables with new set.
     */
    replace(env: Record<string, string>): void {
        this.env = new Map(Object.entries(env));
    }
}
