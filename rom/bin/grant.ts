/**
 * grant - manage file access control lists
 *
 * Usage:
 *   grant +OP USER PATH      Add operation grant for user
 *   grant -OP USER PATH      Remove operation grant from user
 *   grant --deny USER PATH   Add user to deny list
 *   grant --allow USER PATH  Remove user from deny list
 *   grant --list PATH        Show current ACL
 *   grant --reset PATH       Reset ACL to owner-only
 *
 * Operations (OP):
 *   read, write, delete, stat, list, create, *
 *
 * Special users:
 *   *     Everyone (public access)
 *   self  Current process
 *
 * Examples:
 *   grant +read * /public/doc.txt       Make file publicly readable
 *   grant +write alice /shared/file     Grant alice write access
 *   grant -write * /etc/passwd          Remove public write
 *   grant --deny baduser /important     Block user completely
 *   grant --list /home/user/file        Show who has access
 */

import {
    getargs,
    getcwd,
    getpid,
    access,
    eprintln,
    println,
    exit,
} from '/lib/process';
import { resolvePath } from '/lib/shell';
import type { ACL, Grant } from '/lib/process';

async function main(): Promise<void> {
    const args = await getargs();
    const argv = args.slice(1);

    if (argv.length === 0 || argv[0] === '-h' || argv[0] === '--help') {
        await showHelp();
        await exit(0);
    }

    const cwd = await getcwd();

    // Parse command
    const cmd = argv[0];

    if (cmd === '--list' || cmd === '-l') {
        if (argv.length < 2) {
            await eprintln('grant: --list requires a path');
            await exit(1);
        }
        const path = resolvePath(cwd, argv[1]);
        await listAcl(path);
    } else if (cmd === '--reset') {
        if (argv.length < 2) {
            await eprintln('grant: --reset requires a path');
            await exit(1);
        }
        const path = resolvePath(cwd, argv[1]);
        await resetAcl(path);
    } else if (cmd === '--deny') {
        if (argv.length < 3) {
            await eprintln('grant: --deny requires USER and PATH');
            await exit(1);
        }
        const user = await resolveUser(argv[1]);
        const path = resolvePath(cwd, argv[2]);
        await denyUser(path, user);
    } else if (cmd === '--allow') {
        if (argv.length < 3) {
            await eprintln('grant: --allow requires USER and PATH');
            await exit(1);
        }
        const user = await resolveUser(argv[1]);
        const path = resolvePath(cwd, argv[2]);
        await allowUser(path, user);
    } else if (cmd.startsWith('+')) {
        const op = cmd.slice(1);
        if (!op) {
            await eprintln('grant: missing operation after +');
            await exit(1);
        }
        if (argv.length < 3) {
            await eprintln('grant: +OP requires USER and PATH');
            await exit(1);
        }
        const user = await resolveUser(argv[1]);
        const path = resolvePath(cwd, argv[2]);
        await addGrant(path, user, op);
    } else if (cmd.startsWith('-') && !cmd.startsWith('--')) {
        const op = cmd.slice(1);
        if (!op) {
            await eprintln('grant: missing operation after -');
            await exit(1);
        }
        if (argv.length < 3) {
            await eprintln('grant: -OP requires USER and PATH');
            await exit(1);
        }
        const user = await resolveUser(argv[1]);
        const path = resolvePath(cwd, argv[2]);
        await removeGrant(path, user, op);
    } else {
        await eprintln(`grant: unknown command: ${cmd}`);
        await eprintln('Try "grant --help" for usage');
        await exit(1);
    }

    await exit(0);
}

async function showHelp(): Promise<void> {
    await println('Usage:');
    await println('  grant +OP USER PATH      Add operation grant for user');
    await println('  grant -OP USER PATH      Remove operation grant from user');
    await println('  grant --deny USER PATH   Add user to deny list');
    await println('  grant --allow USER PATH  Remove user from deny list');
    await println('  grant --list PATH        Show current ACL');
    await println('  grant --reset PATH       Reset ACL to owner-only');
    await println('');
    await println('Operations:');
    await println('  read, write, delete, stat, list, create, *');
    await println('');
    await println('Special users:');
    await println('  *     Everyone (public access)');
    await println('  self  Current process');
    await println('');
    await println('Examples:');
    await println('  grant +read * /public/doc.txt');
    await println('  grant --list /home/user/file');
}

async function resolveUser(user: string): Promise<string> {
    if (user === 'self') {
        const pid = await getpid();
        return String(pid);
    }
    return user;
}

async function listAcl(path: string): Promise<void> {
    try {
        const acl = await access(path);
        await println(`ACL for ${path}:`);
        await println('');

        if (acl.grants.length === 0) {
            await println('  Grants: (none)');
        } else {
            await println('  Grants:');
            for (const grant of acl.grants) {
                const ops = grant.ops.join(', ');
                const exp = grant.expires ? ` (expires: ${new Date(grant.expires).toISOString()})` : '';
                await println(`    ${grant.to}: ${ops}${exp}`);
            }
        }

        await println('');
        if (acl.deny.length === 0) {
            await println('  Deny: (none)');
        } else {
            await println('  Deny:');
            for (const user of acl.deny) {
                await println(`    ${user}`);
            }
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`grant: ${path}: ${msg}`);
        await exit(1);
    }
}

async function resetAcl(path: string): Promise<void> {
    try {
        await access(path, null);
        await println(`ACL reset to owner-only: ${path}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`grant: ${path}: ${msg}`);
        await exit(1);
    }
}

async function denyUser(path: string, user: string): Promise<void> {
    try {
        const acl = await access(path);

        if (!acl.deny.includes(user)) {
            acl.deny.push(user);
            await access(path, acl);
            await println(`Denied ${user} access to ${path}`);
        } else {
            await println(`${user} already denied`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`grant: ${path}: ${msg}`);
        await exit(1);
    }
}

async function allowUser(path: string, user: string): Promise<void> {
    try {
        const acl = await access(path);

        const idx = acl.deny.indexOf(user);
        if (idx !== -1) {
            acl.deny.splice(idx, 1);
            await access(path, acl);
            await println(`Removed ${user} from deny list for ${path}`);
        } else {
            await println(`${user} was not denied`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`grant: ${path}: ${msg}`);
        await exit(1);
    }
}

async function addGrant(path: string, user: string, op: string): Promise<void> {
    try {
        const acl = await access(path);

        // Find existing grant for user
        let grant = acl.grants.find((g: Grant) => g.to === user);

        if (grant) {
            if (!grant.ops.includes(op) && !grant.ops.includes('*')) {
                grant.ops.push(op);
            }
        } else {
            acl.grants.push({ to: user, ops: [op] });
        }

        await access(path, acl);
        await println(`Granted ${op} to ${user} on ${path}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`grant: ${path}: ${msg}`);
        await exit(1);
    }
}

async function removeGrant(path: string, user: string, op: string): Promise<void> {
    try {
        const acl = await access(path);

        const grant = acl.grants.find((g: Grant) => g.to === user);

        if (grant) {
            const idx = grant.ops.indexOf(op);
            if (idx !== -1) {
                grant.ops.splice(idx, 1);
            }

            // Remove grant entirely if no ops left
            if (grant.ops.length === 0) {
                const grantIdx = acl.grants.indexOf(grant);
                acl.grants.splice(grantIdx, 1);
            }

            await access(path, acl);
            await println(`Revoked ${op} from ${user} on ${path}`);
        } else {
            await println(`${user} has no grants on ${path}`);
        }
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        await eprintln(`grant: ${path}: ${msg}`);
        await exit(1);
    }
}

main().catch(async (err) => {
    await eprintln(`grant: ${err.message}`);
    await exit(1);
});
