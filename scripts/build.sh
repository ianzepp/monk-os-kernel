#!/bin/bash

#
# Compilation Script for Monk API
#
# Compiles TypeScript source code and copies non-TS assets to dist/
# This ensures all runtime dependencies are available in the compiled output.
#

set -euo pipefail

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[0;33m'
readonly NC='\033[0m' # No Color

# Script directory and project root
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

cleanup() {
    local exit_code=$?
    if [[ $exit_code -ne 0 ]]; then
        log_error "Compilation failed with exit code $exit_code"
    fi
    exit $exit_code
}

trap cleanup EXIT

main() {
    cd "$PROJECT_ROOT"

    log_info "Starting compilation process..."

    # Step 0: Validate message-pure kernel (no JSON serialization in kernel code)
    # Exemptions:
    #   - hal/channel/     : network boundary (TCP/UDP/WebSocket)
    #   - vfs/             : storage boundary (entity/ACL persistence)
    #   - kernel/mounts.ts : parses /etc/mounts.json config
    #   - kernel/pool.ts   : parses /etc/pools.json config
    #   - kernel/kernel.ts : parses service .json definitions
    log_info "Validating message-pure kernel architecture..."
    local json_violations=$(grep -rn 'JSON\.parse\|JSON\.stringify' src/ \
        --include='*.ts' \
        --exclude-dir='channel' \
        --exclude-dir='vfs' \
        2>/dev/null \
        | grep -v 'hal/crypto.ts' \
        | grep -v 'kernel/mounts.ts' \
        | grep -v 'kernel/pool.ts' \
        | grep -v 'kernel/kernel.ts' \
        | grep -v 'kernel/types.ts' \
        || true)
    if [[ -n "$json_violations" ]]; then
        log_warn "Kernel code should be message-pure (no JSON serialization)"
        log_warn "Found JSON.parse/JSON.stringify in non-exempted code:"
        echo "$json_violations" | while read -r line; do
            log_warn "  $line"
        done
        log_warn "JSON serialization is only allowed at:"
        log_warn "  - Network boundaries (hal/channel/)"
        log_warn "  - Storage boundaries (vfs/)"
        log_warn "  - Config file parsing (kernel/mounts.ts, kernel/pool.ts)"
        log_warn "  - Service definitions (kernel/kernel.ts)"
    fi
    log_info "Message-pure validation passed"

    # Step 0b: Warn about generic Error usage (prefer typed errors like ENOENT, EACCES, etc.)
    # Exemptions:
    #   - hal/errors.ts   : defines the error classes themselves
    #   - hal/channel/    : external protocol boundaries
    #   - hal/network/    : external protocol boundaries
    #   - hal/crypto.ts   : crypto-specific errors
    #   - hal/ipc.ts      : IPC-specific errors (mutex/semaphore)
    #   - hal/entropy.ts  : entropy-specific errors
    log_info "Checking for generic Error usage..."
    local error_violations=$(grep -rn 'new Error(' src/ \
        --include='*.ts' \
        --exclude-dir='channel' \
        --exclude-dir='network' \
        2>/dev/null \
        | grep -v 'hal/errors.ts' \
        | grep -v 'hal/crypto.ts' \
        | grep -v 'hal/ipc.ts' \
        | grep -v 'hal/entropy.ts' \
        || true)
    if [[ -n "$error_violations" ]]; then
        log_warn "Prefer typed errors (ENOENT, EACCES, EBADF, etc.) over generic Error"
        log_warn "Found 'new Error(' in non-exempted code:"
        echo "$error_violations" | while read -r line; do
            log_warn "  $line"
        done
        log_warn "Typed errors are defined in hal/errors.ts"
        log_warn "Generic errors are allowed in:"
        log_warn "  - Error definitions (hal/errors.ts)"
        log_warn "  - External boundaries (hal/channel/, hal/network/)"
        log_warn "  - Low-level HAL (hal/crypto.ts, hal/ipc.ts, hal/entropy.ts)"
    fi

    # Clean existing dist directory
    if [[ -d "dist" ]]; then
        log_info "Cleaning existing dist/ directory"
        rm -rf dist/
    fi

    # Step 1: TypeScript compilation
    log_info "Compiling TypeScript sources..."
    if ! npx tsc -p tsconfig.json; then
        log_error "TypeScript compilation failed"
        exit 1
    fi

    # Step 2: Resolve path aliases
    log_info "Resolving TypeScript path aliases..."
    if ! npx tsc-alias -p tsconfig.json; then
        log_error "Path alias resolution failed"
        exit 1
    fi

    # Step 3: Copy non-TypeScript assets
    # Note: src/describedata was removed - test fixture models are in spec/fixtures/model/
    log_info "Checking for additional assets to copy..."

    # Step 4: Copy ROM filesystem (OS bootstrap files)
    if [[ -d "rom" ]]; then
        log_info "Copying ROM filesystem..."
        cp -r rom dist/rom
        log_info "Copied ROM: $(find rom -type f | wc -l | tr -d ' ') files"
    fi

    # Step 5: Copy USR filesystem (user-space application code)
    if [[ -d "usr" ]]; then
        log_info "Copying USR filesystem..."
        cp -r usr dist/rom/usr
        log_info "Copied USR: $(find usr -type f | wc -l | tr -d ' ') files"
    fi

    local ts_files=$(find src -name '*.ts' | wc -l | tr -d ' ')
    local js_files=$(find dist -name '*.js' | wc -l | tr -d ' ')

    log_info "Compilation summary:"
    log_info "  TypeScript files: $ts_files"
    log_info "  JavaScript files: $js_files"
    log_info "Compilation completed successfully!"
}

main "$@"
