# Middleware Architecture

This document explains the Monk API middleware pipeline and the **Response Pipeline** pattern that handles all response transformations.

## Overview

The Monk API uses a single **Response Pipeline Middleware** that orchestrates all response transformations in a predetermined order. This replaces the previous complex approach of stacking multiple middleware that each overrode `context` methods.

## Middleware Execution Order

### For Protected Routes (`/api/*`)

```
1. bodyParserMiddleware           - Decode TOON/YAML/JSON request bodies
2. authValidatorMiddleware        - Validate JWT/API key and user
3. formatDetectorMiddleware       - Detect desired response format (?format=)
4. responseTransformerMiddleware  - [SINGLE OVERRIDE POINT]
5. contextInitializerMiddleware   - Provide database context
   ↓
   Route Handler Executes
   ↓
   Response pipeline processes result
```

### For Public Routes (`/auth/*`)

```
1. bodyParserMiddleware     - Decode request bodies
2. formatDetectorMiddleware       - Detect desired response format
3. responseTransformerMiddleware      - [SINGLE OVERRIDE POINT]
   ↓
   Route Handler Executes
   ↓
   Response pipeline processes result
```

## Response Pipeline Architecture

### The Problem (Old Approach)

Previously, we had multiple middleware each overriding context methods:
- `fieldExtractionMiddleware` - Cloned responses, re-parsed JSON, re-created responses
- `responseFormatterMiddleware` - Overrode `context.json()` (only for non-JSON formats)
- `encryptionMiddleware` - Needed to override BOTH `context.json()` and `context.text()`

This led to:
- ❌ Complex override stacking
- ❌ Response cloning hacks
- ❌ Difficult to debug
- ❌ Fragile error handling

### The Solution (Current Approach)

**Single middleware** (`responseTransformerMiddleware`) that:
1. Overrides `context.json()` ONCE before route handlers run
2. When routes call `context.json(data)`, runs transformations in order
3. Returns final formatted/encrypted response

```typescript
Route: context.json({ success: true, data: {...} })
  ↓
Response Pipeline intercepts
  ↓
Step 1: Field Extraction (?unwrap, ?select=, ?stat=false, ?access=false)
  ↓
Step 2: Format Conversion (?format=yaml|csv|toon|etc)
  ↓
Step 3: Encryption (?encrypt=pgp)
  ↓
Client receives final response
```

### Benefits

✅ **Single override point** - Clear, linear execution
✅ **No response cloning** - Process data before response creation
✅ **Explicit pipeline order** - Visible, deterministic
✅ **Handles edge cases naturally** - Text responses, errors, binary all work
✅ **Easier to test and debug** - Single unit to test

## Pipeline Steps

### Step 1: Field Extraction

**Query Parameters:**
- `?unwrap` - Remove envelope, return full data object
- `?select=id,name` - Remove envelope, return specific fields
- `?stat=false` - Exclude timestamp fields (created_at, updated_at, etc.)
- `?access=false` - Exclude ACL fields (access_read, access_edit, etc.)

**Examples:**
```bash
# Unwrap envelope
GET /api/user/whoami?unwrap
→ {"id": "...", "name": "...", "access": "root"}

# Select specific fields
GET /api/user/whoami?select=id,name
→ {"id": "...", "name": "..."}

# Select single field (returns plain text)
GET /api/user/whoami?select=id
→ "c81d0a9b-8d9a-4daf-9f45-08eb8bc3805c"

# Exclude system fields
GET /api/data/users?stat=false&access=false
→ [...] (without timestamps and ACL fields)
```

**Implementation:** Uses `field-extractor.ts` and `system-field-filter.ts` utilities

---

### Step 2: Format Conversion

**Query Parameter:** `?format=<format>`

**Supported Formats:**
- `json` - Standard JSON (default)
- `toon` - Compact format for LLMs (~30-40% fewer tokens)
- `yaml` - YAML format
- `toml` - TOML configuration format
- `csv` - CSV tabular data (array of objects only)
- `msgpack` - MessagePack binary format
- `brainfuck` - Brainfuck encoding (novelty)
- `morse` - Morse code encoding
- `qr` - QR code ASCII art
- `markdown` - Markdown tables and lists

**Examples:**
```bash
# YAML format
GET /api/user/whoami?format=yaml
→ success: true
  data:
    id: ...

# CSV format (for array responses)
GET /api/find/users?format=csv
→ id,name,email
  "...", "...", "..."

# TOON format (compact for LLMs)
GET /api/user/whoami?format=toon
→ success: true
  data:
    id: ...
```

**Implementation:** Uses formatters from `src/lib/formatters/`

---

### Step 3: Encryption (Optional)

**Query Parameter:** `?encrypt=pgp`

**What it does:**
- Encrypts the formatted response using AES-256-GCM
- Derives encryption key from user's JWT token using PBKDF2
- Returns PGP-style ASCII armor

**Security Model:**
- **Ephemeral encryption** - For transport security, not long-term storage
- JWT token IS the decryption key
- Same JWT = same key (allows decryption)
- JWT expiry = old encrypted messages become undecryptable

**Examples:**
```bash
# Encrypt JSON response
GET /api/user/whoami?encrypt=pgp
→ -----BEGIN MONK ENCRYPTED MESSAGE-----
  Version: Monk-API/3.0
  Cipher: AES-256-GCM

  <base64-encoded encrypted data>
  -----END MONK ENCRYPTED MESSAGE-----

# Encrypt YAML response
GET /api/user/whoami?format=yaml&encrypt=pgp
→ (encrypted YAML output)

# Decrypt
tsx scripts/decrypt.ts "$JWT_TOKEN" < encrypted.txt
```

**IMPORTANT:**
- ✅ Encrypts ALL responses including errors (prevents info leakage)
- ⚠️ Requires valid JWT token
- ⚠️ Not suitable for archival storage (JWT expiry)

**Implementation:** Uses encryption utilities from `src/lib/encryption/`

## Composability

All query parameters work together seamlessly:

```bash
# Extract fields + format + encrypt
GET /api/user/whoami?select=id,name&format=yaml&encrypt=pgp

# Unwrap + exclude system fields + CSV
GET /api/find/users?unwrap&stat=false&format=csv

# Select field + TOON format
GET /api/user/whoami?select=access&format=toon
→ root
```

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| Routes calling `context.text()` directly | Skip pipeline (docs, markdown responses) |
| Error responses | Go through full pipeline (format + encrypt) |
| Primitive values | Pass through without processing |
| Missing JWT + `?encrypt=pgp` | Return unencrypted (graceful fallback) |
| Invalid format parameter | Fall back to JSON |
| Format encoding failure | Fall back to JSON with error logged |

## Middleware Details

### bodyParserMiddleware

**Purpose**: Decode request bodies from various formats to JSON

**What it does**:
- Detects `Content-Type` header
- Decodes TOON/YAML/TOML/Morse → JSON
- Sets decoded JSON as request body

**File**: `src/lib/middleware/request-body-parser.ts`

---

### formatDetectorMiddleware

**Purpose**: Detect which format the client wants for responses

**What it does**:
- Checks (in order):
  1. `?format=` query parameter
  2. `Accept` header
  3. JWT token format preference
- Stores result in `context.set('responseFormat', format)`

**File**: `src/lib/middleware/format-detection.ts`

---

### responseTransformerMiddleware

**Purpose**: Transform JSON responses through extraction → formatting → encryption

**What it overrides**: `context.json()`

**How it works**:
1. Runs BEFORE route handlers
2. Overrides `context.json()` to intercept all JSON responses
3. When route calls `context.json(data)`:
   - Applies field extraction
   - Converts to requested format
   - Encrypts if requested
   - Returns final response

**Key insight**: Routes remain completely unaware of transformations. They call `context.json()` and the pipeline handles everything transparently.

**File**: `src/lib/middleware/response-pipeline.ts`

---

### contextInitializerMiddleware

**Purpose**: Provide database context to routes

**What it does**:
- Attaches `setRouteResult()` helper to context
- Provides database pool connection
- Handles global error catching

**File**: `src/lib/middleware/system-context.ts`

## Adding New Pipeline Steps

To add a new transformation step:

1. Add step function in `response-pipeline.ts`:
   ```typescript
   function applyMyTransformation(data: any, context: Context): any {
       // Your transformation logic
       return transformedData;
   }
   ```

2. Add step to pipeline in `responseTransformerMiddleware()`:
   ```typescript
   // Step 1: Field Extraction
   result = applyFieldExtraction(result, context);

   // Step 2: Your new step
   result = applyMyTransformation(result, context);

   // Step 3: Format Conversion
   const { text, contentType } = applyFormatter(result, context);
   ```

3. No changes needed to:
   - Route handlers
   - Other middleware
   - Client code

## Testing the Pipeline

### Test Format Conversion
```bash
# JSON (default)
monk curl GET '/api/user/whoami'

# YAML
monk curl GET '/api/user/whoami?format=yaml'

# CSV (requires array response)
monk curl GET '/api/find/users?format=csv'
```

### Test Encryption
```bash
# Encrypt JSON
monk curl GET '/api/user/whoami?encrypt=pgp' > encrypted.txt

# Decrypt
TOKEN=$(monk curl POST '/auth/login' -d '{"tenant":"demo","username":"root"}' | jq -r '.data.token')
tsx scripts/decrypt.ts "$TOKEN" < encrypted.txt
```

### Test Composition
```bash
# Extract + format + encrypt
monk curl GET '/api/user/whoami?select=id,name&format=yaml&encrypt=pgp'
```

## Performance Considerations

**Overhead:**
- Single override per request (minimal)
- Early exit for non-JSON responses
- Format conversion only when requested
- Encryption only when requested

**Optimization:**
- Formatters are cached (not reloaded per request)
- Field extraction uses lightweight dot-notation parser
- No response cloning or re-parsing

## Summary

The Monk API uses a **Single Response Pipeline** architecture:

- ✅ One middleware handles all transformations
- ✅ Clean, linear execution order
- ✅ Routes remain format/encryption-agnostic
- ✅ Easy to extend with new steps
- ✅ Natural edge case handling
- ✅ Fully composable query parameters

For more details:
- **Formatters**: See `src/lib/formatters/README.md`
- **Encryption**: See design doc for security model
- **Field Extraction**: See `src/lib/field-extractor.ts`
