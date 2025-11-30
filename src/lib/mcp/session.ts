/**
 * MCP Session Management
 *
 * File-backed session storage for MCP connections.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { McpSession } from './types.js';

const SESSION_FILE = process.env.MCP_SESSION_FILE || '.data/mcp-sessions.json';

// In-memory cache backed by file
let sessionCache: Map<string, McpSession> | null = null;

function loadSessions(): Map<string, McpSession> {
    if (sessionCache) return sessionCache;

    try {
        if (existsSync(SESSION_FILE)) {
            const data = readFileSync(SESSION_FILE, 'utf-8');
            const parsed = JSON.parse(data) as Record<string, McpSession>;
            sessionCache = new Map(Object.entries(parsed));
            console.info(`MCP: Loaded ${sessionCache.size} session(s) from ${SESSION_FILE}`);
        } else {
            sessionCache = new Map();
        }
    } catch (error) {
        console.warn(`MCP: Failed to load sessions from ${SESSION_FILE}:`, error);
        sessionCache = new Map();
    }

    return sessionCache;
}

function saveSessions(): void {
    if (!sessionCache) return;

    try {
        const dir = dirname(SESSION_FILE);
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }

        const data = Object.fromEntries(sessionCache);
        writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.warn(`MCP: Failed to save sessions to ${SESSION_FILE}:`, error);
    }
}

export function getOrCreateSession(sessionId: string): McpSession {
    const sessions = loadSessions();
    const cached = sessions.get(sessionId);
    if (cached) return cached;

    const newSession: McpSession = { token: null, tenant: null };
    sessions.set(sessionId, newSession);
    return newSession;
}

export function updateSession(sessionId: string, session: McpSession): void {
    const sessions = loadSessions();
    sessions.set(sessionId, session);
    saveSessions();
}
