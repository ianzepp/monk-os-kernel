/**
 * Monk API - Main Entry Point
 *
 * Orchestrates server startup:
 * - Environment loading and validation
 * - Infrastructure initialization
 * - Observer preloading
 * - Server startup (HTTP, Telnet, SSH)
 * - Graceful shutdown coordination
 */

// Set PROJECT_ROOT before anything else
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.PROJECT_ROOT = join(__dirname, '..');

// Import process environment as early as possible
import { loadEnv } from '@src/lib/env/load-env.js';

// Load environment-specific .env file
const envFile = process.env.NODE_ENV ? `.env.${process.env.NODE_ENV}` : '.env';
loadEnv({ path: envFile, debug: true });

// Default to standalone mode if DATABASE_URL not set
// This enables zero-config startup: just run the binary
if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'sqlite:root';
}

// Import infrastructure management
import { Infrastructure, parseInfraConfig } from '@src/lib/infrastructure.js';

// Check infrastructure mode (sqlite vs postgresql)
const infraConfig = parseInfraConfig();
const isSqliteMode = infraConfig.dbType === 'sqlite';

// Set defaults for SQLite mode (zero-config standalone)
if (isSqliteMode) {
    // Set default SQLITE_DATA_DIR if not specified
    if (!process.env.SQLITE_DATA_DIR) {
        process.env.SQLITE_DATA_DIR = '.data';
    }
    // Set default PORT if not specified
    if (!process.env.PORT) {
        process.env.PORT = '9001';
    }
    // Set default NODE_ENV if not specified
    if (!process.env.NODE_ENV) {
        process.env.NODE_ENV = 'development';
    }
}

// Sanity check for required env values
if (!process.env.DATABASE_URL) {
    throw Error('Fatal: environment is missing "DATABASE_URL"');
}

if (!process.env.PORT) {
    throw Error('Fatal: environment is missing "PORT"');
}

if (!process.env.JWT_SECRET) {
    throw Error('Fatal: environment is missing "JWT_SECRET"');
}

if (!process.env.NODE_ENV) {
    throw Error('Fatal: environment is missing "NODE_ENV"');
}

// Database connection for cleanup
import { DatabaseConnection } from '@src/lib/database-connection.js';

// Observer preload
import { ObserverLoader } from '@src/lib/observers/loader.js';

// Servers
import { startHttpServer, createHttpApp, type HttpServerHandle } from '@src/servers/http.js';
import { startTelnetServer, type TelnetServerHandle } from '@src/servers/telnet.js';
import { startSSHServer, type SSHServerHandle } from '@src/servers/ssh.js';
import { startMcpServer, type McpServerHandle } from '@src/servers/mcp.js';

// Cron scheduler
import { Crontab } from '@src/lib/crontab.js';

// Check database connection before doing anything else
console.info('Checking database connection:');
console.info('- NODE_ENV:', process.env.NODE_ENV);
console.info('- PORT:', process.env.PORT);
console.info('- DATABASE_URL:', process.env.DATABASE_URL);
console.info('- SQLITE_DATA_DIR:', process.env.SQLITE_DATA_DIR);
console.info('- Infrastructure mode:', infraConfig.dbType);

// Initialize infrastructure (creates tenants table if needed)
await Infrastructure.initialize();

if (!isSqliteMode) {
    // PostgreSQL mode: also verify connection pool health
    DatabaseConnection.healthCheck();
}

console.info('Infrastructure ready', {
    dbType: infraConfig.dbType,
    database: infraConfig.database,
});

// Initialize observer system
console.info('Preloading observer system');
try {
    ObserverLoader.preloadObservers();
    console.info('Observer system ready', {
        observerCount: ObserverLoader.getObserverCount(),
    });
} catch (error) {
    console.error(`Observer system initialization failed:`, error);
    console.warn('Continuing without observer system');
}

// Check for --no-startup flag
if (process.argv.includes('--no-startup')) {
    console.info('Startup test successful - all modules loaded without errors');
    process.exit(0);
}

// Server handles for graceful shutdown
let httpServer: HttpServerHandle | null = null;
let telnetServer: TelnetServerHandle | null = null;
let sshServer: SSHServerHandle | null = null;
let mcpServer: McpServerHandle | null = null;

// Start HTTP server
console.info('Starting Monk API servers');
console.info('Related ecosystem projects:');
console.info('- monk-cli: Terminal commands for the API (https://github.com/ianzepp/monk-cli)');
console.info('- monk-uix: Web browser admin interface (https://github.com/ianzepp/monk-uix)');
console.info(
    '- monk-api-bindings-ts: Typescript API bindings (https://github.com/ianzepp/monk-api-bindings-ts)'
);

// Log available app packages (lazy-loaded on first request)
try {
    const { discoverApps } = await import('@src/lib/apps/loader.js');
    const availableApps = await discoverApps();
    if (availableApps.length > 0) {
        console.info('Available app packages (lazy-loaded on first request):');
        for (const appName of availableApps) {
            console.info(`- @monk-app/${appName} -> /app/${appName}`);
        }
    } else {
        console.info('No app packages installed');
    }
} catch (error) {
    console.info('No app packages installed');
}

// Start all servers
const httpPort = Number(process.env.PORT || 9001);
httpServer = startHttpServer(httpPort);

// Start TTY servers
const ttyConfig = {
    telnetPort: Number(process.env.TELNET_PORT || 2323),
    telnetHost: process.env.TELNET_HOST || '0.0.0.0',
    sshPort: Number(process.env.SSH_PORT || 2222),
    sshHost: process.env.SSH_HOST || '0.0.0.0',
    sshHostKey: process.env.SSH_HOST_KEY,
};

telnetServer = startTelnetServer(ttyConfig);
sshServer = startSSHServer(ttyConfig);

// Start MCP server (shares the HTTP app for API calls)
const mcpConfig = {
    port: Number(process.env.MCP_PORT || 3001),
    host: process.env.MCP_HOST || '0.0.0.0',
};
mcpServer = startMcpServer(httpServer.app, mcpConfig);

// Start cron scheduler (PostgreSQL only - requires processes table)
if (!isSqliteMode) {
    Crontab.startScheduler();
}

// Graceful shutdown
const gracefulShutdown = async () => {
    console.info('Shutting down servers gracefully');

    // Stop cron scheduler
    Crontab.stopScheduler();

    // Stop all servers
    httpServer?.stop();
    telnetServer?.stop();
    sshServer?.stop();
    mcpServer?.stop();

    // Close database connections
    await DatabaseConnection.closeConnections();
    console.info('Database connections closed');

    process.exit(0);
};

process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Named export for testing (avoid default export - Bun auto-serves default exports with fetch())
const app = httpServer.app;
export { app };
