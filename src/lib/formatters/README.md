# Response Format & Field Extraction API

The Monk API supports multiple response formats to optimize for different use cases, from human readability to token efficiency for LLM integrations. Additionally, server-side field extraction eliminates the need for client-side `jq` piping in test scripts.

## Quick Examples

### Format Only
```bash
# Get response in TOON format
curl http://localhost:9001/api/user/whoami?format=toon
```

### Field Extraction Only
```bash
# Extract single field (returns plain text)
curl http://localhost:9001/api/user/whoami?select=id
→ c81d0a9b-8d9a-4daf-9f45-08eb8bc3805c

# Extract multiple fields (returns JSON object)
curl http://localhost:9001/api/user/whoami?select=id,name
→ {"id":"c81d0a9b...","name":"Demo User"}
```

### Combined: Extract + Format
```bash
# Extract fields THEN format as TOON
curl http://localhost:9001/api/user/whoami?select=id,name&format=toon
→ id: c81d0a9b...
  name: Demo User
```

## Supported Formats

### JSON (Default)
Standard JSON format with 2-space indentation.

**Request:**
```bash
curl -X POST http://localhost:9001/auth/login \
  -H "Content-Type: application/json" \
  -d '{"tenant":"toon-test","username":"root"}'
```

**Response:**
```json
{
  "success": true,
  "data": {
    "token": "eyJhbGc...",
    "user": {...}
  }
}
```

**With Field Extraction:**
```bash
curl http://localhost:9001/auth/login?select=token \
  -d '{"tenant":"demo","username":"root"}'
→ eyJhbGc... (plain text token)
```

### TOON
Compact, human-readable format designed for reduced token usage in LLM applications.

**Request:**
```bash
curl -X POST http://localhost:9001/auth/login \
  -H "Content-Type: application/toon" \
  -H "Accept: application/toon" \
  -d 'tenant: toon-test
username: root'
```

**Response:**
```toon
success: true
data:
  token: eyJhbGc...
  user:
    ...
```

**With Field Extraction:**
```bash
curl http://localhost:9001/api/user/whoami?select=id,access&format=toon
→ id: c81d0a9b...
  access: root
```

### YAML
Standard YAML format for human readability and compatibility.

**Request:**
```bash
curl -X POST http://localhost:9001/auth/login \
  -H "Content-Type: application/yaml" \
  -H "Accept: application/yaml" \
  -d 'tenant: toon-test
username: root'
```

**Response:**
```yaml
success: true
data:
  token: eyJhbGc...
  user:
    ...
```

**With Field Extraction:**
```bash
curl http://localhost:9001/api/user/whoami?select=access_read,access_edit&format=yaml
→ access_read: []
  access_edit: []
```

### TOML
TOML (Tom's Obvious, Minimal Language) configuration file format. Clean and human-readable with explicit typing.

**Request:**
```bash
curl -X POST http://localhost:9001/auth/login \
  -H "Content-Type: application/toml" \
  -H "Accept: application/toml" \
  -d 'tenant = "toon-test"
username = "root"'
```

**Response:**
```toml
success = true

[data]
token = "eyJhbGc..."

[data.user]
id = "c81d0a9b-8d9a-4daf-9f45-08eb8bc3805c"
name = "Demo User"
```

**Features:**
- Clear, minimal syntax
- Explicit data types (strings, integers, booleans, dates)
- Section headers for nested structures
- Popular for configuration files
- Better than JSON for human editing

**With Field Extraction:**
```bash
curl http://localhost:9001/api/user/whoami?select=id,access&format=toml
→ id = "c81d0a9b..."
  access = "root"
```

**Use Cases:**
- Configuration files
- Infrastructure as Code (IaC)
- Application settings
- Deployment manifests
- CI/CD pipeline configuration

### CSV (Response-Only)
Comma-Separated Values format for tabular data export. Perfect for Excel, Google Sheets, and data analysis tools.

**Request:**
```bash
# CSV export of user list (automatically unwraps data)
curl http://localhost:9001/api/find/users?format=csv
```

**Response:**
```csv
id,name,email,created_at,status
"c81d0a9b-8d9a-4daf-9f45-08eb8bc3805c","Demo User","demo@example.com","2025-01-15T10:30:00Z","active"
"a72f3bc4-1d2e-4f3a-8e91-2bc7d9e4f6a1","Jane Smith","jane@example.com","2025-01-16T14:22:00Z","active"
```

**Features:**
- Automatic envelope removal (`?unwrap` implied)
- Header row with field names
- Quoted fields for safety
- Proper CSV escaping
- **Only works with array of objects** - validates data structure
- Nested objects are JSON-stringified
- Empty arrays produce headers only

**IMPORTANT Constraints:**
```bash
# ✓ Works: Array of objects
curl /api/find/users?format=csv
→ Returns CSV with headers

# ✗ Error: Not an array
curl /api/user/whoami?format=csv
→ HTTP 500: "CSV format requires an array of objects"

# ✗ Error: Array of primitives
curl /api/data/tags?format=csv
→ HTTP 500: "CSV format requires array of plain objects"
```

**With Field Extraction:**
```bash
# Select specific fields before CSV export
curl /api/find/users?select=id,name,email&format=csv
→ id,name,email
  "c81d...", "Demo User","demo@example.com"
```

**Error Handling:**
- Invalid data structure → HTTP 500 with JSON error message
- Success responses → CSV data with HTTP 200
- Errors always return JSON (never CSV)

**Use Cases:**
- Data export for Excel/Google Sheets
- Reporting and analytics
- Bulk data extraction
- Integration with BI tools
- Database query results export

### MessagePack
Binary serialization format that's more compact than JSON. Ideal for high-performance APIs and bandwidth-constrained environments.

**Request:**
```bash
# Encode JSON to MessagePack (base64) and send
echo '{"tenant":"demo","username":"root"}' | \
  msgpack encode | base64 | \
  curl -X POST http://localhost:9001/auth/login \
    -H "Content-Type: application/msgpack" \
    --data-binary @-
```

**Response:**
```bash
curl http://localhost:9001/auth/tenants?format=msgpack | base64 -d
```

**Features:**
- 30-50% smaller than JSON
- Binary format for efficiency
- Full type preservation (integers, floats, binary data)
- Base64-encoded for HTTP transport
- Widely supported across languages

**With Field Extraction:**
```bash
# Extract token and return as MessagePack
curl http://localhost:9001/auth/login?select=token&format=msgpack \
  -d '{"tenant":"demo","username":"root"}' | base64 -d
```

**Use Cases:**
- High-performance APIs
- Bandwidth-constrained networks
- Microservice communication
- IoT/embedded systems
- Mobile applications

### Morse Code
Converts JSON to/from Morse code (dots and dashes). Uses hex encoding internally to preserve case sensitivity.

**Request:**
```bash
curl -X POST http://localhost:9001/auth/login \
  -H "Content-Type: application/morse" \
  -H "Accept: application/morse" \
  -d '--... -... ..--- ..--- --... ....- ...'
```

**Response:**
```
--... -... ----- .- ..--- ----- ..--- ----- ..--- ..--- --... ...-- ...
```

**How it works:**
1. JSON → Hex encoding (preserves case, only 0-9 A-F)
2. Hex → Morse code (dots and dashes)
3. Morse → Hex → JSON (perfect round-trip)

**With Field Extraction:**
```bash
# Extract field and return as Morse code
curl http://localhost:9001/api/user/whoami?select=name&format=morse
```

### QR Code (Response-Only)
Generates scannable ASCII art QR codes from JSON responses. Perfect for mobile access and air-gapped data transfer.

**Request:**
```bash
curl http://localhost:9001/auth/tenants?format=qr
```

**Response:**
```
█████████████████████████████████████████
██ ▄▄▄▄▄ █▀ ▀█▀  ▀▄█ ▄█▀  ▀▀▄▄█  █▄▀ ▄▄▀██
██ █   █ ██▀█▀▀█ ██   █▀█ ▀▄▄██▀▄██ ▄▄▄██
██ █▄▄▄█ █▄▄  ▀▄▀▄█ ██▀▀█▀ ▄▄▄ ▀ ▀█  ▀▄ ██
██▄▄▄▄▄▄▄█▄█ ▀▄▀▄█ ▀ █ ▀▄▀ █▄█ ▀▄▀ █ ▀ ███
...
```

**Features:**
- Scannable with any QR code reader app
- Medium error correction for reliability
- Unicode block characters (█ ▀ ▄) for high contrast
- Works in terminals and text displays

**With Field Extraction:**
```bash
# Generate QR code of just the token
curl http://localhost:9001/auth/login?select=token&format=qr \
  -d '{"tenant":"demo","username":"root"}'
```

**Note:** QR code decoding for request bodies is intentionally not supported.

### Markdown (Response-Only)
Converts JSON responses to readable Markdown with tables, lists, and structured formatting. Perfect for documentation and terminal display.

**Request:**
```bash
curl http://localhost:9001/auth/tenants?format=markdown
```

**Response:**
```markdown
# API Response

**Status**: ✓ Success

## Data

| name | description | users |
| --- | --- | --- |
| toon-test |  | ["root","full","user"] |
```

**Features:**
- Arrays of objects → Markdown tables
- Single objects → Key-value lists with bold labels
- Nested structures → Indented sections
- API responses → Status headers with ✓/✗ symbols
- GitHub-compatible output

**With Field Extraction:**
```bash
# Extract nested object and format as Markdown table
curl http://localhost:9001/api/describe?unwrap&format=markdown
```

**Note:** Markdown decoding is not supported as it's a presentation format, not a data serialization format.

## Field Extraction (`?unwrap` and `?select=`)

Server-side field extraction eliminates the need for `curl | jq` piping in test scripts and automation.

### Modes

**No Parameters (Full Envelope):**
```bash
GET /api/user/whoami
→ {"success": true, "data": {"id": "...", "name": "...", ...}}
```

**Unwrap (Remove Envelope):**
```bash
?unwrap                          # Returns full data object without envelope
```

**Select Fields (Remove Envelope + Filter):**
```bash
?select=id                       # Returns single field value
?select=id,name                  # Returns JSON object with selected fields
?select=user.email               # Nested path support
```

### Examples

**Before (with jq):**
```bash
# Unwrap data object
curl /api/user/whoami | jq -r '.data'

# Extract single field
curl /api/user/whoami | jq -r '.data.id'

# Extract multiple fields
curl /api/user/whoami | jq '{id: .data.id, name: .data.name}'
```

**After (with ?unwrap and ?select=):**
```bash
# Unwrap data object (no envelope)
curl /api/user/whoami?unwrap
→ {"id":"c81d0a9b...","name":"Demo User","access":"root",...}

# Extract single field (returns plain text)
curl /api/user/whoami?select=id
→ c81d0a9b-8d9a-4daf-9f45-08eb8bc3805c

# Extract multiple fields (returns JSON object)
curl /api/user/whoami?select=id,name
→ {"id":"c81d0a9b...","name":"Demo User"}

# Extract and format (one request)
curl /api/user/whoami?select=id,name&format=toon
→ id: c81d0a9b...
  name: Demo User
```

### Features

- **Three Modes**: Full envelope (default), unwrap (remove envelope), select (filter fields)
- **Nested Paths**: Use dot notation (`.`) to traverse objects: `select=user.email`
- **Multiple Fields**: Comma-separate paths to extract multiple fields: `select=id,name`
- **Implicit Scope**: `?select=` operates within `data` automatically (no need for `data.` prefix)
- **Single Value Return**: Single fields return plain text (no JSON wrapping)
- **Multiple Value Return**: Multiple fields return JSON object
- **Graceful Handling**: Missing fields return `null`/`undefined`
- **Format Compatible**: Works with all response formats (JSON, TOON, YAML, etc.)
- **Shell-Safe**: No special characters requiring quotes in URLs
- **Transparent**: Routes are unaware of extraction - happens at API boundary

### Use Cases

**Test Scripts:**
```bash
# Get unwrapped user data
USER_DATA=$(curl /api/user/whoami?unwrap)

# Get just the token for subsequent requests
TOKEN=$(curl /auth/login?select=token -d '{"tenant":"demo","username":"root"}')

# Verify specific field value
USER_ACCESS=$(curl /api/user/whoami?select=access)
[[ "$USER_ACCESS" == "root" ]] && echo "Admin access confirmed"
```

**CI/CD Pipelines:**
```bash
# Get unwrapped data for processing
curl /api/describe?unwrap | jq 'length'

# Get database name for backup scripts
DB_NAME=$(curl /api/user/whoami?select=database)
backup-database "$DB_NAME"
```

**Development/Debugging:**
```bash
# Quick field inspection without jq
curl /api/data/users/123?select=email

# Compare fields across formats
curl /api/user/whoami?select=id,name&format=toon
curl /api/user/whoami?select=id,name&format=yaml

# Get full data without envelope
curl /api/data/users/123?unwrap
```

## Format Selection

Formats can be specified in three ways (in priority order):

### 1. Query Parameter
```bash
curl http://localhost:9001/auth/tenants?format=toon
```

### 2. Accept Header
```bash
curl http://localhost:9001/auth/tenants \
  -H "Accept: application/toon"
```

### 3. JWT Format Preference
Specify format during login and it will be stored in your JWT token:
```bash
curl -X POST http://localhost:9001/auth/login \
  -d '{"tenant":"toon-test","username":"root","format":"toon"}'
```

All subsequent requests with that JWT will default to TOON format.

## Bidirectional Support

| Format | Request Support | Response Support | Field Extraction | Auto-Unwrap |
|--------|----------------|------------------|------------------|-------------|
| JSON | ✓ | ✓ | ✓ | ✗ |
| TOON | ✓ | ✓ | ✓ | ✗ |
| YAML | ✓ | ✓ | ✓ | ✗ |
| TOML | ✓ | ✓ | ✓ | ✗ |
| CSV | ✗ | ✓ (array only) | ✓ | ✓ |
| MessagePack | ✓ | ✓ | ✓ | ✗ |
| Brainfuck | ✗ | ✓ | ✓ | ✗ |
| Morse | ✓ | ✓ | ✓ | ✗ |
| QR Code | ✗ | ✓ | ✓ | ✗ |
| Markdown | ✗ | ✓ | ✓ | ✗ |

**Note:** Field extraction works with all response formats - data is extracted first (from JSON), then formatted.

## Content-Type Headers

Request bodies must specify the correct Content-Type header:

- JSON: `application/json`
- TOON: `application/toon` or `text/plain`
- YAML: `application/yaml` or `text/yaml`
- TOML: `application/toml` or `application/x-toml`
- CSV: Not supported for requests (response-only)
- MessagePack: `application/msgpack` or `application/x-msgpack`
- Morse: `application/morse` or `text/plain` (with morse pattern)

**Note:** CSV decoding is intentionally not supported for request bodies.

## Use Cases

### JSON
- Standard REST API clients
- Web applications
- Mobile apps
- Default format for all endpoints

### TOON
- LLM applications (reduced token usage ~30-40%)
- Chat interfaces
- AI agents
- Claude Code API interactions

### YAML
- Configuration management
- Human-readable exports
- Documentation examples
- CI/CD pipeline data

### TOML
- Configuration files
- Infrastructure as Code (IaC)
- Application settings
- Deployment manifests
- CI/CD pipeline configuration

### CSV
- Data export for Excel/Google Sheets
- Reporting and analytics dashboards
- Bulk data extraction
- Integration with BI tools
- Database query results export

### MessagePack
- High-performance APIs
- Bandwidth-constrained networks
- Microservice communication
- IoT/embedded systems
- Mobile applications
- Binary data transfer

### Brainfuck
- Novelty applications
- Educational demonstrations
- Esoteric programming challenges
- Because we can

### Morse Code
- Ham radio integrations
- Accessibility applications
- Educational/novelty use
- Audio transmission scenarios

### QR Code
- Mobile device access (scan with phone camera)
- Screen sharing / presentations
- Air-gapped data transfer
- Terminal-based workflows
- Quick data sharing without copy/paste
- Token distribution via QR scan

### Markdown
- API documentation generation
- GitHub issues and pull requests
- Terminal-friendly output (`curl | less`)
- Copy/paste into documentation
- Report generation
- Human-readable exports

### Field Extraction (`?select=`)
- **Test Scripts**: Eliminate `| jq` piping
- **CI/CD**: Extract specific values for automation
- **Debugging**: Quick field inspection
- **Token Extraction**: Get auth tokens directly
- **Data Validation**: Check specific field values
- **Bandwidth Optimization**: Return only needed fields

## Implementation Details

All format and extraction handling is implemented in:

**Field Extraction:**
- `src/lib/field-extractor.ts` - Lightweight dot-notation utility (~100 lines, no dependencies)
- `src/lib/system-field-filter.ts` - System field filtering (?stat=false, ?access=false)

**Format Handling:**
- `src/lib/formatters/` - Encoding/decoding logic for each format
  - `json.ts` - Standard JSON (default)
  - `toon.ts` - Compact TOON format
  - `yaml.ts` - YAML format
  - `toml.ts` - TOML configuration format
  - `csv.ts` - CSV tabular data (response-only, auto-unwrap)
  - `msgpack.ts` - MessagePack binary format
  - `brainfuck.ts` - Brainfuck encoding (response-only)
  - `morse.ts` - Morse code encoding/decoding
  - `qr.ts` - QR code ASCII art (response-only)
  - `markdown.ts` - Markdown formatting (response-only)

**Encryption:**
- `src/lib/encryption/aes-gcm.ts` - AES-256-GCM encryption/decryption
- `src/lib/encryption/key-derivation.ts` - JWT-based key derivation (PBKDF2)
- `src/lib/encryption/pgp-armor.ts` - PGP-style ASCII armor encoding

**Middleware Pipeline:**
- `src/lib/middleware/response-pipeline.ts` - **Single pipeline** for all transformations (extract → format → encrypt)
- `src/lib/middleware/request-body-parser.ts` - Request parsing (TOON/YAML/Morse → JSON)
- `src/lib/middleware/format-detection.ts` - Format selection (query param → header → JWT)

**Processing Order:**
1. **Request**: `request-body-parser` decodes TOON/YAML/Morse → JSON
2. **Route Logic**: Works with JSON objects (format-agnostic)
3. **Response Pipeline**: Single middleware handles all transformations:
   - **Step 1**: Field extraction (?unwrap, ?select=, ?stat=false, ?access=false)
   - **Step 2**: Format conversion (?format=yaml|csv|toon|etc)
   - **Step 3**: Encryption (?encrypt=pgp)

## Architecture Principles

### Single Response Pipeline
All response transformations happen in one middleware (`response-pipeline.ts`):
- Single override of `context.json()`
- Explicit, deterministic processing order
- No response cloning or re-parsing
- Easy to extend with new transformation steps

### Transparent at API Boundary
Routes always work with JSON objects - pipeline operates transparently:
```typescript
// Route handler - always works with JSON
export default async function(context: Context) {
    return context.json({
        success: true,
        data: { id: "123", name: "Test" }
    });
}

// Response pipeline handles transformations:
// - ?format=toon → encodes to TOON
// - ?select=id → extracts field first
// - ?select=id&format=toon → extracts then encodes
// - ?encrypt=pgp → encrypts final output
```

### No Dependencies
Field extraction is implemented without external libraries:
- Simple dot-notation parser (~30 lines)
- Recursive object traversal
- Graceful null/undefined handling

### Performance
- Single override per request (minimal overhead)
- Early exit for non-JSON responses
- Field extraction only runs when `?select=` or `?unwrap` present
- Format conversion only runs when `?format=` specified
- Encryption only runs when `?encrypt=pgp` specified
- Formatters are cached (not reloaded per request)

## Testing

Format and extraction functionality is tested in:

**Format Tests:**
- `spec/51-formatters/format-toon.test.sh` - TOON encoding/decoding
- `spec/51-formatters/format-yaml.test.sh` - YAML encoding/decoding
- `spec/51-formatters/format-morse.test.sh` - Morse code encoding/decoding

**Extraction Tests:**
- `spec/10-auth/whoami.test.sh` - Single/multiple field extraction
- Integration tests verify `?select=` work with all formats

**Test Coverage:**
- Single field extraction (returns plain text)
- Multiple field extraction (returns JSON object)
- Nested path extraction (`data.user.email`)
- Missing field handling (returns `null`)
- Format compatibility (`?select=` + `?format=`)
- All supported formatters tested

## monk curl Integration

The `monk curl` command provides simplified access with automatic authentication:

```bash
# Standard request
monk curl GET /api/user/whoami

# With field extraction
monk curl GET '/api/user/whoami?select=id'

# With format
monk curl GET '/api/user/whoami?format=toon'

# Combined
monk curl GET '/api/user/whoami?select=id,name&format=yaml'
```

The command handles:
- Automatic JWT token injection
- Proper URL encoding
- Pre-configured server/tenant
- Shell escaping (no need to escape `&` in URLs)

## Advanced Examples

### Extract Array Elements
```bash
# Get first tenant name
curl /auth/tenants?select=[0].name
→ demo-01

# Get all tenant names (if data is array of objects)
curl /auth/tenants?unwrap&format=json | jq -r '.[].name'
```

### Chain with jq (When Needed)
```bash
# Extract then transform with jq
curl /api/user/whoami?unwrap | jq -r '.access'

# Or just extract directly
curl /api/user/whoami?select=access
```

### Format Comparison
```bash
# Compare same data in different formats
curl /api/user/whoami?select=id,name
curl /api/user/whoami?select=id,name&format=toon
curl /api/user/whoami?select=id,name&format=yaml
curl /api/user/whoami?select=id,name&format=markdown
```

### Token Usage Optimization
```bash
# Full response (verbose JSON)
curl /api/user/whoami
→ {"success":true,"data":{"id":"...","name":"...","access":"...","tenant":"...","database":"...","access_read":[],"access_edit":[],"access_full":[]}}

# Extract only needed fields + TOON format (minimal tokens)
curl /api/user/whoami?select=id,access&format=toon
→ id: c81d0a9b...
  access: root
```

## Error Handling

### Missing Fields
```bash
curl /api/user/whoami?select=nonexistent
→ null  (graceful)
```

### Invalid Path Syntax
```bash
curl /api/user/whoami?select=.invalid
→ null  (graceful - treats as missing)
```

### Empty Pick Parameter
```bash
curl /api/user/whoami?select=
→ (returns full response - extraction skipped)
```

### Extraction with Errors
If extraction fails, the original response is returned with a logged error.

## Migration Guide

### From jq to ?unwrap/?select

**Old Approach:**
```bash
#!/bin/bash
TOKEN=$(curl /auth/login -d '{"tenant":"demo","username":"root"}' | jq -r '.data.token')
USER_ID=$(curl /api/user/whoami -H "Authorization: Bearer $TOKEN" | jq -r '.data.id')
```

**New Approach:**
```bash
#!/bin/bash
TOKEN=$(curl /auth/login?select=token -d '{"tenant":"demo","username":"root"}')
USER_ID=$(curl /api/user/whoami?select=id -H "Authorization: Bearer $TOKEN")
```

**Benefits:**
- One less dependency (`jq` not required)
- Faster (server-side extraction)
- Fewer characters
- Less shell escaping issues

## Response Encryption (`?encrypt=pgp`)

In addition to format encoding, responses can be encrypted for transport security.

### Encryption Model

**Query Parameter**: `?encrypt=pgp`  
**Encryption**: AES-256-GCM (authenticated encryption)  
**Key Derivation**: PBKDF2 from user's JWT token  
**Output Format**: PGP-style ASCII armor  

**Processing Pipeline:**
```
Request → Route Logic → ?select=/?unwrap → ?format= → ?encrypt=pgp → Response
```

**Example:**
```bash
# Encrypt JSON response
curl /api/user/whoami?encrypt=pgp \
  -H "Authorization: Bearer $JWT" > encrypted.txt

# Decrypt with same JWT
tsx scripts/decrypt.ts "$JWT" < encrypted.txt

# Combine with formatting
curl /api/find/users?format=csv&encrypt=pgp \
  -H "Authorization: Bearer $JWT" > users-encrypted.txt
```

**ASCII Armor Format:**
```
-----BEGIN MONK ENCRYPTED MESSAGE-----
Version: Monk-API/3.0
Cipher: AES-256-GCM

<base64-encoded: IV + ciphertext + authTag>
-----END MONK ENCRYPTED MESSAGE-----
```

### Security Model (Ephemeral Encryption)

**Purpose**: Transport security, NOT long-term storage

✅ **Good for:**
- Secure transmission over untrusted networks
- Defense-in-depth beyond HTTPS
- Preventing sensitive data logging in proxies
- Compliance demonstrations

⚠️ **Limitations:**
- JWT token IS the decryption key (if leaked, encryption broken)
- No perfect forward secryption
- JWT expiry means old encrypted messages become undecryptable
- Not suitable for archival/long-term storage

**User Flow:**
1. Request with `?encrypt=pgp` and valid JWT
2. Receive encrypted response
3. Decrypt IMMEDIATELY with same JWT
4. Store plaintext or re-encrypt with own keys

### Decryption

**Using Decrypt Script:**
```bash
# From stdin
curl /api/user/whoami?encrypt=pgp -H "Authorization: Bearer $JWT" \
  | tsx scripts/decrypt.ts "$JWT"

# From file
tsx scripts/decrypt.ts "$JWT" encrypted-response.txt
```

**What Gets Encrypted:**
- The final formatted response (after all formatters run)
- Works with any format: JSON, CSV, YAML, etc.
- Respects `?select=` and `?unwrap` parameters

**Error Handling:**
```bash
# Missing JWT → 401 error (JSON response)
curl /api/user/whoami?encrypt=pgp
→ {"success": false, "error": "Encryption requires authentication"}

# Invalid JWT → Decryption fails with clear error message
```

### Composability

```bash
# Select fields, format as CSV, then encrypt
curl /api/find/users?select=id,email&format=csv&encrypt=pgp

# Unwrap data, format as YAML, then encrypt
curl /api/describe?unwrap&format=yaml&encrypt=pgp

# Extract single field, then encrypt
curl /api/user/whoami?select=id&encrypt=pgp
```

### Important Security Warnings

⚠️ **DO:**
- Decrypt responses immediately after receiving
- Use for secure transmission over untrusted networks
- Treat JWT token as encryption password (keep secure)

❌ **DON'T:**
- Store encrypted responses long-term
- Expect to decrypt after JWT expires/rotates
- Use as replacement for proper encryption-at-rest
- Share encrypted messages (tied to YOUR JWT)

**After JWT rotation, old encrypted messages become undecryptable.**  
This is by design - encryption is for transport security, not archival storage.

## Summary

The Monk API provides a flexible, extensible format system with field extraction and optional encryption:

✅ **10 Formats**: JSON, TOON, YAML, TOML, CSV, MessagePack, Brainfuck, Morse, QR, Markdown
✅ **Response Encryption**: AES-256-GCM with JWT-based key derivation
✅ **Bidirectional**: Request + response support (where applicable)
✅ **Format Detection**: Query param → Accept header → JWT preference
✅ **Field Extraction**: Server-side `?select=` eliminates `| jq` piping
✅ **Auto-Unwrap**: CSV automatically removes envelope for direct data export
✅ **Composable**: Combine ?select, ?format, and ?encrypt in any order
✅ **Transparent**: Routes work with JSON, formatters/encryption handle encoding
✅ **Minimal Dependencies**: Lightweight implementation with industry-standard libraries
✅ **Fully Tested**: Comprehensive test coverage in `spec/`
✅ **monk curl**: Simplified CLI with automatic authentication

Perfect for secure data export, LLM integrations, configuration management, high-performance APIs, test automation, CI/CD pipelines, and human-readable API exploration.
