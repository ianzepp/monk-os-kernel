#!/bin/bash

#
# Code Quality Warnings for Monk OS
#
# Scans for patterns that indicate code quality issues that TypeScript
# won't catch. These are warnings, not errors - the build will still succeed.
#
# Run via: bun run build:warn
#

set -euo pipefail

# Colors for output
readonly RED='\033[0;31m'
readonly GREEN='\033[0;32m'
readonly YELLOW='\033[0;33m'
readonly CYAN='\033[0;36m'
readonly NC='\033[0m' # No Color

# Script directory and project root
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# Counters
total_warnings=0

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
}

log_warn() {
    echo -e "${YELLOW}[WARN]${NC} $1"
}

log_error() {
    echo -e "${RED}[ERROR]${NC} $1"
}

log_check() {
    echo -e "${CYAN}[CHECK]${NC} $1"
}

# Run a check and report violations
# Arguments:
#   $1 - Check name
#   $2 - Why this matters
#   $3 - grep pattern
#   $4 - Additional grep excludes (optional, pipe-separated)
run_check() {
    local name="$1"
    local reason="$2"
    local pattern="$3"
    local excludes="${4:-}"

    log_check "$name"

    # Build the grep command
    local results
    results=$(grep -rn "$pattern" src/ --include='*.ts' 2>/dev/null || true)

    # Apply excludes if provided
    if [[ -n "$excludes" ]]; then
        # Split excludes by pipe and apply each
        IFS='|' read -ra exclude_array <<< "$excludes"
        for exclude in "${exclude_array[@]}"; do
            results=$(echo "$results" | grep -v "$exclude" || true)
        done
    fi

    if [[ -n "$results" ]]; then
        local count=$(echo "$results" | wc -l | tr -d ' ')
        total_warnings=$((total_warnings + count))
        log_warn "Found $count instance(s): $reason"
        echo "$results" | while read -r line; do
            echo -e "  ${YELLOW}→${NC} $line"
        done
        echo ""
    else
        log_info "No issues found"
    fi
}

main() {
    cd "$PROJECT_ROOT"

    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo -e "${CYAN}  Monk OS Code Quality Warnings${NC}"
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""

    # =========================================================================
    # CHECK 1: Console statements
    # =========================================================================
    # Kernel code should use structured logging, not console.*
    # Exemptions:
    #   - boot.ts: Initial bootstrap before logging is available
    #   - bin/: User-space utilities may use console
    run_check \
        "Console statements (console.log/warn/error)" \
        "Kernel should use structured logging, not console" \
        'console\.\(log\|warn\|error\|debug\|info\)' \
        'boot.ts|/bin/'

    # =========================================================================
    # CHECK 2: Debugger statements
    # =========================================================================
    # Debugger statements should never be committed
    # No exemptions
    run_check \
        "Debugger statements" \
        "Debugger statements should never be committed" \
        'debugger'

    # =========================================================================
    # CHECK 3: JSON serialization in kernel code
    # =========================================================================
    # Kernel code should be message-pure (no JSON serialization)
    # Exemptions:
    #   - hal/channel/: Network boundary (TCP/UDP/WebSocket)
    #   - vfs/: Storage boundary (entity/ACL persistence)
    #   - kernel/mounts.ts: Parses /etc/mounts.json config
    #   - kernel/pool.ts: Parses /etc/pools.json config
    #   - kernel/kernel.ts: Parses service .json definitions
    #   - kernel/types.ts: Type definitions
    #   - hal/crypto.ts: Crypto utilities
    log_check "JSON serialization in kernel code"
    local json_results
    json_results=$(grep -rn 'JSON\.parse\|JSON\.stringify' src/ --include='*.ts' \
        --exclude-dir='channel' \
        --exclude-dir='vfs' \
        2>/dev/null \
        | grep -v 'hal/crypto.ts' \
        | grep -v 'kernel/mounts.ts' \
        | grep -v 'kernel/pool.ts' \
        | grep -v 'kernel/kernel.ts' \
        | grep -v 'kernel/types.ts' \
        || true)
    if [[ -n "$json_results" ]]; then
        local count=$(echo "$json_results" | wc -l | tr -d ' ')
        total_warnings=$((total_warnings + count))
        log_warn "Found $count instance(s): Kernel should be message-pure (no JSON serialization)"
        echo "$json_results" | while read -r line; do
            echo -e "  ${YELLOW}→${NC} $line"
        done
        echo ""
    else
        log_info "No issues found"
    fi

    # =========================================================================
    # CHECK 5: TypeScript escape hatches (@ts-ignore, @ts-nocheck)
    # =========================================================================
    # Type suppression comments hide type errors
    # Exemptions:
    #   - None - these should be extremely rare and well-justified
    run_check \
        "TypeScript escape hatches (@ts-ignore, @ts-nocheck, @ts-expect-error)" \
        "Type suppression hides errors - fix the types instead" \
        '@ts-ignore\|@ts-nocheck\|@ts-expect-error'

    # =========================================================================
    # CHECK 6: Type any usage
    # =========================================================================
    # 'any' bypasses type checking entirely
    # Exemptions:
    #   - hal/errors.ts: Error class definitions need 'any' for compatibility
    #   - hal/network/: Bun socket types are untyped
    #   - hal/dns.ts: DNS result types vary
    #   - hal/crypto.ts: Bun crypto types need casting
    #   - hal/console.ts: Stdin reader type
    log_check "Type 'any' usage (as any, : any)"
    local any_results
    any_results=$(grep -rn ': any\|as any' src/ --include='*.ts' 2>/dev/null \
        | grep -v 'hal/errors.ts' \
        | grep -v 'hal/network/' \
        | grep -v 'hal/dns.ts' \
        | grep -v 'hal/crypto.ts' \
        | grep -v 'hal/console.ts' \
        | grep -v '^\s*//' \
        | grep -v '^\s*\*' \
        | grep -v '/\*' \
        || true)
    # Filter out comment lines (lines where : any or as any appears after // or *)
    any_results=$(echo "$any_results" | grep -v '//.*: any\|//.*as any\|\*.*: any\|\*.*as any' || true)
    if [[ -n "$any_results" ]]; then
        local count=$(echo "$any_results" | wc -l | tr -d ' ')
        total_warnings=$((total_warnings + count))
        log_warn "Found $count instance(s): Type 'any' bypasses type safety - use 'unknown' or proper types"
        echo "$any_results" | while read -r line; do
            echo -e "  ${YELLOW}→${NC} $line"
        done
        echo ""
    else
        log_info "No issues found"
    fi

    # =========================================================================
    # CHECK 7: Deep relative imports (architecture smell)
    # =========================================================================
    # Imports with 3+ levels of ../ suggest poor module boundaries
    # Exemptions:
    #   - None - use @src/ path aliases instead
    run_check \
        "Deep relative imports (../../../)" \
        "Use @src/ path aliases instead of deep relative imports" \
        'from ['\''"]\.\.\/\.\.\/\.\.\/'

    # =========================================================================
    # CHECK 8: Generic Error usage
    # =========================================================================
    # Prefer typed errors (ENOENT, EACCES, etc.) over generic Error
    # Exemptions:
    #   - hal/errors.ts: Defines the error classes
    #   - hal/channel/, hal/network/: External protocol boundaries
    #   - hal/crypto.ts, hal/ipc.ts, hal/entropy.ts: Low-level HAL
    local error_results
    error_results=$(grep -rn 'new Error(' src/ --include='*.ts' \
        --exclude-dir='channel' \
        --exclude-dir='network' \
        2>/dev/null \
        | grep -v 'hal/errors.ts' \
        | grep -v 'hal/crypto.ts' \
        | grep -v 'hal/ipc.ts' \
        | grep -v 'hal/entropy.ts' \
        || true)

    log_check "Generic Error usage (new Error)"
    if [[ -n "$error_results" ]]; then
        local count=$(echo "$error_results" | wc -l | tr -d ' ')
        total_warnings=$((total_warnings + count))
        log_warn "Found $count instance(s): Prefer typed errors (ENOENT, EACCES, EBADF, etc.)"
        echo "$error_results" | while read -r line; do
            echo -e "  ${YELLOW}→${NC} $line"
        done
        echo ""
    else
        log_info "No issues found"
    fi

    # =========================================================================
    # CHECK 9: Bun usage outside HAL
    # =========================================================================
    # Bun primitives should only be used in HAL - the rest of the OS must go
    # through HAL to access hardware. This enforces the architectural boundary.
    # Exemptions:
    #   - src/hal/: HAL's job is to wrap Bun primitives
    #   - spec/: Test files may use bun:test
    log_check "Bun usage outside HAL (Bun.*, bun:*)"

    # Check for Bun. global access outside hal/
    local bun_global_results
    bun_global_results=$(grep -rn 'Bun\.' src/ --include='*.ts' 2>/dev/null \
        | grep -v '/hal/' \
        || true)

    # Check for bun: imports outside hal/
    local bun_import_results
    bun_import_results=$(grep -rn "from ['\"]bun:" src/ --include='*.ts' 2>/dev/null \
        | grep -v '/hal/' \
        || true)

    # Combine results
    local bun_results=""
    if [[ -n "$bun_global_results" ]]; then
        bun_results="$bun_global_results"
    fi
    if [[ -n "$bun_import_results" ]]; then
        if [[ -n "$bun_results" ]]; then
            bun_results="$bun_results"$'\n'"$bun_import_results"
        else
            bun_results="$bun_import_results"
        fi
    fi

    if [[ -n "$bun_results" ]]; then
        local count=$(echo "$bun_results" | wc -l | tr -d ' ')
        total_warnings=$((total_warnings + count))
        log_warn "Found $count instance(s): Bun primitives should only be used in HAL"
        echo "$bun_results" | while read -r line; do
            echo -e "  ${YELLOW}→${NC} $line"
        done
        echo ""
    else
        log_info "No issues found"
    fi

    # =========================================================================
    # CHECK 10: process.env usage outside HAL
    # =========================================================================
    # Environment variables should be accessed through HAL, not directly via
    # process.env. This ensures consistent handling and testability.
    # Exemptions:
    #   - src/hal/: HAL's job is to provide env access
    #   - src/boot.ts: Bootstrap before HAL is available
    log_check "process.env usage outside HAL"

    local env_results
    env_results=$(grep -rn 'process\.env' src/ --include='*.ts' 2>/dev/null \
        | grep -v '/hal/' \
        | grep -v 'boot.ts' \
        || true)

    if [[ -n "$env_results" ]]; then
        local count=$(echo "$env_results" | wc -l | tr -d ' ')
        total_warnings=$((total_warnings + count))
        log_warn "Found $count instance(s): process.env should only be accessed in HAL"
        echo "$env_results" | while read -r line; do
            echo -e "  ${YELLOW}→${NC} $line"
        done
        echo ""
    else
        log_info "No issues found"
    fi

    # =========================================================================
    # Summary
    # =========================================================================
    echo ""
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    if [[ $total_warnings -eq 0 ]]; then
        echo -e "${GREEN}  No warnings found!${NC}"
    else
        echo -e "${YELLOW}  Total warnings: $total_warnings${NC}"
        echo -e "${YELLOW}  These are suggestions for improvement, not build failures.${NC}"
    fi
    echo -e "${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
    echo ""
}

main "$@"
