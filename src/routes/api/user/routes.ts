/**
 * User API Routes - User Management
 *
 * Provides endpoints for user management within a tenant:
 * - List users: GET /api/user (requires sudo)
 * - Create user: POST /api/user (requires sudo)
 * - Get user: GET /api/user/:id (self or sudo)
 * - Update user: PUT /api/user/:id (self-limited or sudo)
 * - Delete user: DELETE /api/user/:id (self-deactivate or sudo)
 * - Sudo token: POST /api/user/sudo (root/full users)
 * - Impersonate: POST /api/user/fake (root users)
 *
 * The :id parameter can be a UUID or "me" for the current user.
 * Self-service operations use withSelfServiceSudo() for the users table.
 */

// Collection endpoints
export { default as UserList } from './GET.js';
export { default as UserCreate } from './POST.js';

// Individual user endpoints
export { default as UserGet } from './:id/GET.js';
export { default as UserUpdate } from './:id/PUT.js';
export { default as UserDelete } from './:id/DELETE.js';

// Special endpoints
export { default as SudoPost } from './sudo/POST.js';
export { default as FakePost } from './fake/POST.js';

// Password management
export { default as PasswordPost } from './:id/password/POST.js';

// API key management
export { default as KeysList } from './:id/keys/GET.js';
export { default as KeysCreate } from './:id/keys/POST.js';
export { default as KeysDelete } from './:id/keys/:keyId/DELETE.js';
