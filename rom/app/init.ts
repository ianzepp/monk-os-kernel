/**
 * Init Process
 *
 * The first process (PID 1) in Monk OS.
 * Discovers and spawns applications, loads models, reaps zombie children.
 *
 * Boot sequence:
 * 1. Load all app models from /app/{name}/models/{model}.yaml
 * 2. Spawn all apps from /app/{name}/main.ts
 * 3. Reap zombie children forever
 */

import {
    call,
    wait,
    spawn,
    onSignal,
    sleep,
    getpid,
    println,
    eprintln,
    readdirAll,
    readFile,
    stat,
    ESRCH,
} from '@rom/lib/process/index.js';

// =============================================================================
// STATE
// =============================================================================

/**
 * Child process tracking
 */
const children = new Map<number, string>(); // pid -> app name

// =============================================================================
// MODEL LOADING
// =============================================================================

/**
 * Parse YAML content into an object.
 * Simple YAML parser for model definitions.
 */
function parseYaml(content: string): Record<string, unknown> {
    // For now, assume models are in JSON format
    // TODO: Add proper YAML parsing when hal.yaml is exposed to userspace
    return JSON.parse(content);
}

/**
 * Load all models for an app.
 */
async function loadAppModels(appName: string): Promise<void> {
    const modelsDir = `/app/${appName}/models`;

    try {
        await stat(modelsDir);
    }
    catch {
        // No models directory, skip
        return;
    }

    const files = await readdirAll(modelsDir);

    for (const entry of files) {
        if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.json')) {
            continue;
        }

        const ext = entry.name.endsWith('.yaml') ? '.yaml' : '.json';
        const modelName = entry.name.slice(0, -ext.length);
        const modelPath = `${modelsDir}/${entry.name}`;

        try {
            const content = await readFile(modelPath);
            const def = parseYaml(content);

            await call('ems:import', modelName, def);
            await println(`init: loaded model ${modelName} from ${appName}`);
        }
        catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            await eprintln(`init: failed to load model ${modelPath}: ${message}`);
        }
    }
}

/**
 * Load all models from all apps.
 */
async function loadAllModels(): Promise<void> {
    try {
        await stat('/app');
    }
    catch {
        await println('init: no /app directory, skipping model loading');

        return;
    }

    const apps = await readdirAll('/app');

    for (const entry of apps) {
        await loadAppModels(entry.name);
    }
}

// =============================================================================
// APP SPAWNING
// =============================================================================

/**
 * Spawn an app.
 */
async function spawnApp(appName: string): Promise<void> {
    const mainPath = `/app/${appName}/main.ts`;

    try {
        await stat(mainPath);
    }
    catch {
        // No main.ts, skip (might be a library-only app)
        return;
    }

    try {
        const pid = await spawn(mainPath);

        children.set(pid, appName);
        await println(`init: started ${appName} (pid ${pid})`);
    }
    catch (err) {
        const message = err instanceof Error ? err.message : String(err);

        await eprintln(`init: failed to start ${appName}: ${message}`);
    }
}

/**
 * Spawn all apps.
 */
async function spawnAllApps(): Promise<void> {
    try {
        await stat('/app');
    }
    catch {
        await println('init: no /app directory, skipping app spawning');

        return;
    }

    const apps = await readdirAll('/app');

    for (const entry of apps) {
        await spawnApp(entry.name);
    }
}

// =============================================================================
// MAIN
// =============================================================================

/**
 * Main init loop
 */
async function main(): Promise<void> {
    const pid = await getpid();

    await println(`init: starting (pid ${pid})`);

    // Ignore SIGTERM - init cannot be killed
    onSignal(() => {
        // Silently ignore
    });

    // Phase 1: Load all app models
    await println('init: loading models...');
    await loadAllModels();

    // Phase 2: Spawn all apps
    await println('init: spawning apps...');
    await spawnAllApps();

    await println('init: boot complete');

    // Phase 3: Reap children forever
    await reapLoop();
}

/**
 * Continuously poll for zombie children and reap them.
 */
async function reapLoop(): Promise<void> {
    while (true) {
        for (const [pid, appName] of children) {
            try {
                const status = await wait(pid);

                await println(`init: reaped ${appName} (pid ${pid}) with code ${status.code}`);
                children.delete(pid);
            }
            catch (error: unknown) {
                // ESRCH = No such process (still running or already reaped)
                if (!(error instanceof ESRCH)) {
                    await eprintln(`init: wait error for pid ${pid}: ${error}`);
                }
            }
        }

        await sleep(100);
    }
}

// Run init
main().catch(async err => {
    await eprintln(`init: fatal error: ${err}`);
});
