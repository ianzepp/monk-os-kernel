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
readonly NC='\033[0m' # No Color

# Script directory and project root
readonly SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
readonly PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

log_info() {
    echo -e "${GREEN}[INFO]${NC} $1"
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
