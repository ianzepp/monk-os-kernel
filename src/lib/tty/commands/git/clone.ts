/**
 * git clone - Clone a repository into the virtual filesystem
 *
 * Usage:
 *   git clone <url> [destination]
 *
 * Supports:
 *   - GitHub: https://github.com/user/repo
 *   - GitLab: https://gitlab.com/user/repo
 *   - Bitbucket: https://bitbucket.org/user/repo
 *
 * If no destination is specified, clones to /tmp/<repo-name>
 *
 * Note: Downloads repository contents only (no .git history).
 * Branch can be specified via ?ref=branch query parameter.
 */

import { resolvePath } from '../../parser.js';
import type { CommandHandler } from '../shared.js';

interface RepoInfo {
    host: 'github' | 'gitlab' | 'bitbucket';
    owner: string;
    repo: string;
    ref: string;
}

/**
 * Parse repository URL into components
 */
function parseRepoUrl(url: string): RepoInfo | null {
    try {
        const parsed = new URL(url);
        const ref = parsed.searchParams.get('ref') || 'HEAD';

        // Remove .git suffix if present
        let pathname = parsed.pathname;
        if (pathname.endsWith('.git')) {
            pathname = pathname.slice(0, -4);
        }

        const parts = pathname.split('/').filter(Boolean);
        if (parts.length < 2) return null;

        const owner = parts[0];
        const repo = parts[1];

        if (parsed.host === 'github.com') {
            return { host: 'github', owner, repo, ref };
        } else if (parsed.host === 'gitlab.com') {
            return { host: 'gitlab', owner, repo, ref };
        } else if (parsed.host === 'bitbucket.org') {
            return { host: 'bitbucket', owner, repo, ref };
        }

        return null;
    } catch {
        return null;
    }
}

/**
 * Fetch repository file tree from GitHub API
 * Returns the tree and the resolved branch name for raw file fetching
 */
async function fetchGitHubTree(
    owner: string,
    repo: string,
    ref: string,
    signal?: AbortSignal
): Promise<{ branch: string; files: Array<{ path: string; type: 'blob' | 'tree'; sha: string }> }> {
    // Get repo info to find default branch (single API call)
    const repoUrl = `https://api.github.com/repos/${owner}/${repo}`;
    const repoRes = await fetch(repoUrl, { signal });

    if (!repoRes.ok) {
        throw new Error(`Repository not found: ${owner}/${repo}`);
    }

    const repoData = (await repoRes.json()) as { default_branch: string };
    const branch = ref === 'HEAD' ? repoData.default_branch : ref;

    // Fetch the tree recursively using branch name
    const treeUrl = `https://api.github.com/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`;
    const treeRes = await fetch(treeUrl, { signal });

    if (!treeRes.ok) {
        const text = await treeRes.text();
        throw new Error(`Failed to fetch tree: ${treeRes.status} ${text}`);
    }

    const treeData = (await treeRes.json()) as { tree: Array<{ path: string; type: string; sha: string }> };
    return {
        branch,
        files: treeData.tree.map((item) => ({
            path: item.path,
            type: item.type as 'blob' | 'tree',
            sha: item.sha,
        })),
    };
}

/**
 * Fetch file content from GitHub using raw.githubusercontent.com
 * This avoids API rate limits (no auth needed, no rate limiting)
 */
async function fetchGitHubRaw(
    owner: string,
    repo: string,
    branch: string,
    path: string,
    signal?: AbortSignal
): Promise<string> {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
    const res = await fetch(url, { signal });

    if (!res.ok) {
        throw new Error(`Failed to fetch file: ${res.status}`);
    }

    return res.text();
}

/**
 * Fetch repository using GitLab API
 */
async function fetchGitLabTree(
    owner: string,
    repo: string,
    ref: string,
    signal?: AbortSignal
): Promise<Array<{ path: string; type: 'blob' | 'tree' }>> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const treeRef = ref === 'HEAD' ? 'main' : ref;
    const url = `https://gitlab.com/api/v4/projects/${projectId}/repository/tree?recursive=true&ref=${treeRef}&per_page=100`;

    const res = await fetch(url, { signal });
    if (!res.ok) {
        // Try master
        const masterUrl = `https://gitlab.com/api/v4/projects/${projectId}/repository/tree?recursive=true&ref=master&per_page=100`;
        const masterRes = await fetch(masterUrl, { signal });
        if (!masterRes.ok) {
            throw new Error(`Failed to fetch tree: ${res.status}`);
        }
        const data = (await masterRes.json()) as Array<{ path: string; type: string }>;
        return data.map((item) => ({
            path: item.path,
            type: item.type as 'blob' | 'tree',
        }));
    }

    const data = (await res.json()) as Array<{ path: string; type: string }>;
    return data.map((item) => ({
        path: item.path,
        type: item.type as 'blob' | 'tree',
    }));
}

/**
 * Fetch file content from GitLab
 */
async function fetchGitLabBlob(
    owner: string,
    repo: string,
    path: string,
    ref: string,
    signal?: AbortSignal
): Promise<string> {
    const projectId = encodeURIComponent(`${owner}/${repo}`);
    const filePath = encodeURIComponent(path);
    const fileRef = ref === 'HEAD' ? 'main' : ref;
    const url = `https://gitlab.com/api/v4/projects/${projectId}/repository/files/${filePath}/raw?ref=${fileRef}`;

    const res = await fetch(url, { signal });
    if (!res.ok) {
        // Try master
        const masterUrl = `https://gitlab.com/api/v4/projects/${projectId}/repository/files/${filePath}/raw?ref=master`;
        const masterRes = await fetch(masterUrl, { signal });
        if (!masterRes.ok) {
            throw new Error(`Failed to fetch file: ${res.status}`);
        }
        return masterRes.text();
    }

    return res.text();
}

export const clone: CommandHandler = async (session, fs, args, io) => {
    if (!fs) {
        io.stderr.write('git clone: filesystem not available\n');
        return 1;
    }

    // Parse arguments
    let url: string | null = null;
    let dest: string | null = null;

    for (const arg of args) {
        if (!arg.startsWith('-')) {
            if (!url) {
                url = arg;
            } else if (!dest) {
                dest = arg;
            }
        }
    }

    if (!url) {
        io.stderr.write('usage: git clone <url> [destination]\n');
        return 1;
    }

    // Parse URL
    const repoInfo = parseRepoUrl(url);
    if (!repoInfo) {
        io.stderr.write(`git clone: unsupported URL: ${url}\n`);
        io.stderr.write('Supported hosts: github.com, gitlab.com, bitbucket.org\n');
        return 1;
    }

    // Determine destination
    const repoName = repoInfo.repo;
    const destPath = dest
        ? resolvePath(session.cwd, dest)
        : `/tmp/${repoName}`;

    io.stdout.write(`Cloning into '${destPath}'...\n`);

    try {
        // Check if destination exists
        try {
            await fs.stat(destPath);
            io.stderr.write(`git clone: destination path '${destPath}' already exists\n`);
            return 1;
        } catch {
            // Good, doesn't exist
        }

        // Create destination directory
        await fs.mkdir(destPath);

        // Fetch tree based on host
        let files: Array<{ path: string; type: string; sha?: string }>;
        let resolvedBranch = repoInfo.ref;

        if (repoInfo.host === 'github') {
            io.stdout.write('Fetching file list from GitHub...\n');
            const result = await fetchGitHubTree(
                repoInfo.owner,
                repoInfo.repo,
                repoInfo.ref,
                io.signal
            );
            files = result.files;
            resolvedBranch = result.branch;
        } else if (repoInfo.host === 'gitlab') {
            io.stdout.write('Fetching file list from GitLab...\n');
            files = await fetchGitLabTree(
                repoInfo.owner,
                repoInfo.repo,
                repoInfo.ref,
                io.signal
            );
        } else {
            io.stderr.write(`git clone: ${repoInfo.host} not yet supported\n`);
            return 1;
        }

        // Filter to just files (blobs)
        const blobs = files.filter(f => f.type === 'blob');
        const dirs = files.filter(f => f.type === 'tree');

        io.stdout.write(`Found ${blobs.length} files in ${dirs.length} directories\n`);

        // Create directories first
        for (const dir of dirs) {
            if (io.signal?.aborted) {
                io.stderr.write('\nAborted\n');
                return 130;
            }
            const dirPath = `${destPath}/${dir.path}`;
            try {
                await fs.mkdir(dirPath);
            } catch {
                // Directory might already exist from parent creation
            }
        }

        // Download files
        let downloaded = 0;
        for (const file of blobs) {
            if (io.signal?.aborted) {
                io.stderr.write('\nAborted\n');
                return 130;
            }

            const filePath = `${destPath}/${file.path}`;

            // Ensure parent directory exists
            const parentPath = filePath.substring(0, filePath.lastIndexOf('/'));
            if (parentPath && parentPath !== destPath) {
                try {
                    await fs.mkdir(parentPath);
                } catch {
                    // Already exists
                }
            }

            try {
                let content: string;

                if (repoInfo.host === 'github') {
                    content = await fetchGitHubRaw(
                        repoInfo.owner,
                        repoInfo.repo,
                        resolvedBranch,
                        file.path,
                        io.signal
                    );
                } else if (repoInfo.host === 'gitlab') {
                    content = await fetchGitLabBlob(
                        repoInfo.owner,
                        repoInfo.repo,
                        file.path,
                        resolvedBranch,
                        io.signal
                    );
                } else {
                    continue;
                }

                await fs.write(filePath, content);
                downloaded++;

                // Progress indicator
                if (downloaded % 10 === 0) {
                    io.stdout.write(`Downloaded ${downloaded}/${blobs.length} files\r`);
                }
            } catch (err) {
                io.stderr.write(`\nWarning: failed to download ${file.path}\n`);
            }
        }

        io.stdout.write(`\nCloned ${downloaded} files to ${destPath}\n`);
        return 0;
    } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') {
            io.stderr.write('\nAborted\n');
            return 130;
        }
        const message = err instanceof Error ? err.message : String(err);
        io.stderr.write(`git clone: ${message}\n`);
        return 1;
    }
};
