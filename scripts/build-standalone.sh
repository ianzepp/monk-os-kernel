#!/bin/bash
# Build standalone Monk API distribution
#
# Creates a single executable using Bun's compile feature.
# The resulting binary runs in SQLite mode with zero configuration:
#   ./monk-api
#
# Output: dist-standalone/monk-api (or monk-api.exe on Windows)

set -e

# Clean up stale bun-build artifacts
rm -f .*.bun-build

# Colors
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Building Standalone Monk API ===${NC}"
echo ""

# 1. Ensure TypeScript is compiled
echo -e "${BLUE}[1/3] Compiling TypeScript...${NC}"
bun run build

# 2. Create output directory
echo -e "${BLUE}[2/3] Preparing output directory...${NC}"
rm -rf dist-standalone
mkdir -p dist-standalone

# 3. Compile to single executable
echo -e "${BLUE}[3/3] Compiling to standalone binary...${NC}"
bun build \
    --compile \
    --minify \
    ./dist/index.js \
    --outfile dist-standalone/monk-api

# Get file size
SIZE=$(du -h dist-standalone/monk-api | cut -f1)

echo ""
echo -e "${GREEN}=== Build Complete ===${NC}"
echo ""
echo "Output: dist-standalone/monk-api ($SIZE)"
echo ""
echo "Usage (zero-config):"
echo "  ./dist-standalone/monk-api"
echo ""
echo "The server will:"
echo "  - Start in SQLite mode (no external database needed)"
echo "  - Create .data/ directory for databases"
echo "  - Listen on port 9001"
echo "  - Start with 0 tenants (register to create one)"
echo ""
echo "Register your first tenant:"
echo "  curl -X POST http://localhost:9001/auth/register \\"
echo "    -H 'Content-Type: application/json' \\"
echo "    -d '{\"tenant\":\"demo\",\"username\":\"admin\",\"password\":\"secret\"}'"
echo ""
echo "Environment overrides:"
echo "  PORT=8080 ./monk-api                  # Different port"
echo "  JWT_SECRET=mysecret ./monk-api        # Production secret"
