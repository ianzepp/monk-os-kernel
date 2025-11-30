# 38-ACLs API Documentation

> **Access Control Lists Management**
>
> The ACLs API provides comprehensive access control management for record-level permissions. It supports four permission levels (read, edit, full, deny) with flexible user and group assignments, bulk operations, and integration with the observer pipeline for security validation.

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Core Endpoints](#core-endpoints)
4. [Permission Levels](#permission-levels)
5. [ACL Management](#acl-management)
6. [Bulk Operations](#bulk-operations)
7. [Integration with Data API](#integration-with-data-api)
8. [Access Control Validation](#access-control-validation)
9. [Error Handling](#error-handling)
10. [Testing](#testing)
11. [Common Use Cases](#common-use-cases)

## Overview

The ACLs API provides fine-grained access control for database records through four distinct permission levels. It enables administrators to manage who can read, edit, or have full control over specific records, with support for both individual users and groups.

### Key Capabilities
- **Four Permission Levels**: Read, Edit, Full, and Deny access
- **User and Group Support**: Assign permissions to individual users or groups
- **Bulk Operations**: Update ACLs for multiple records simultaneously
- **Observer Pipeline**: Automatic validation, security checks, and audit logging
- **Integration**: Seamless integration with Data API and File API
- **Administrative Control**: Admin and root privilege management

### Base URLs
```
POST /api/acls/:model/:record     # Manage ACLs for specific record
POST /api/acls/:model            # Bulk ACL operations with filtering
GET  /api/acls/:model/:record    # Retrieve current ACLs
```

## Authentication

All ACLs API endpoints require valid JWT authentication. The API enforces sudo privileges for ACL management and respects tenant isolation.

```bash
Authorization: Bearer <jwt>
```

### Required Permissions
- **ACL Management**: `full` or `root` access level required
- **ACL Viewing**: `read_data` permission for the model
- **Bulk Operations**: `full` or `root` access level required

## Core Endpoints

### POST /api/acls/:model/:record

Manages ACLs for a specific record, supporting both append (POST) and replace (PUT) operations.

```bash
POST /api/acls/users/user_123456
Content-Type: application/json
Authorization: Bearer <jwt>

{
  "access_read": ["user_789", "group_managers"],
  "access_edit": ["user_789"],
  "access_full": ["user_456"],
  "access_deny": ["user_blocked"]
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "record_id": "user_123456",
    "model": "users",
    "access_lists": {
      "access_read": ["user_789", "group_managers"],
      "access_edit": ["user_789"],
      "access_full": ["user_456"],
      "access_deny": ["user_blocked"]
    },
    "updated_at": "2025-01-01T12:00:00.000Z",
    "updated_by": "full_user"
  }
}
```

### PUT /api/acls/:model/:record

Completely replaces ACLs for a specific record.

```bash
PUT /api/acls/users/user_123456
Content-Type: application/json
Authorization: Bearer <jwt>

{
  "access_read": ["group_public"],
  "access_edit": ["edit_user"],
  "access_full": ["full_user"],
  "access_deny": []
}
```

### GET /api/acls/:model/:record

Retrieves current ACLs for a specific record.

```bash
GET /api/acls/users/user_123456
Authorization: Bearer <jwt>
```

**Response:**
```json
{
  "success": true,
    "data": {
    "record_id": "user_123456",
    "model": "users",
    "access_lists": {
      "access_read": ["user_789", "group_managers"],
      "access_edit": ["user_789"],
      "access_full": ["user_456"],
      "access_deny": ["user_blocked"]
    },
    "effective_permissions": {
      "can_read": ["user_789", "group_managers"],
      "can_edit": ["user_789"],
      "can_delete": ["user_456"],
      "is_denied": ["user_blocked"]
    }
  }
}
```

### POST /api/acls/:model

Performs bulk ACL operations with filtering.

```bash
POST /api/acls/users
Content-Type: application/json
Authorization: Bearer <jwt>

{
  "where": {"department": "engineering", "status": "active"},
  "acl_update": {
    "access_read": {"$add": ["group_engineering"]},
    "access_edit": {"$add": ["group_managers"]},
    "access_full": {"$add": ["user_lead"]}
  }
}
```

## Permission Levels

### access_read
Grants read-only access to records. Users can view but not modify data.

```json
{
  "access_read": [
    "user_123",
    "group_analysts",
    "group_public"
  ]
}
```

**Capabilities:**
- View record data
- Access record metadata
- List records in queries
- Export record data

### access_edit
Grants read and edit access to records. Users can view and modify data but not delete.

```json
{
  "access_edit": [
    "user_456",
    "group_managers",
    "role_editor"
  ]
}
```

**Capabilities:**
- All read permissions
- Update record fields
- Modify record relationships
- Change record status

### access_full
Grants complete control over records including deletion and ACL management.

```json
{
  "access_full": [
    "user_789",
    "group_owners",
    "role_owner"
  ]
}
```

**Capabilities:**
- All read and edit permissions
- Delete/soft delete records
- Manage record ACLs
- Modify record ownership

### access_deny
Explicitly denies access regardless of other permissions. Takes precedence over all other permissions.

```json
{
  "access_deny": [
    "user_blocked",
    "group_suspended",
    "role_terminated"
  ]
}
```

**Behavior:**
- Overrides all other permissions
- Blocks all access to record
- Used for security restrictions
- Takes precedence in permission evaluation

## ACL Management

### Individual Record ACLs
Manage ACLs for specific records:

```json
{
  "access_read": ["user_123", "group_team_a"],
  "access_edit": ["user_456", "group_managers"],
  "access_full": ["user_789"],
  "access_deny": ["user_blocked"]
}
```

### Group-Based Permissions
Use groups for scalable permission management:

```json
{
  "access_read": ["group_public", "group_customers"],
  "access_edit": ["group_support", "group_managers"],
  "access_full": ["group_owners", "group_owners"],
  "access_deny": ["group_blocked", "group_inactive"]
}
```

### Hierarchical Permissions
Implement hierarchical access control:

```json
{
  "access_read": ["group_company", "group_division"],
  "access_edit": ["group_department", "group_team_leads"],
  "access_full": ["group_managers", "user_owner"],
  "access_deny": ["group_contractors", "group_temporary"]
}
```

## Bulk Operations

### Filter-Based Updates
Update ACLs for multiple records matching criteria:

```bash
POST /api/acls/documents
Content-Type: application/json
Authorization: Bearer <jwt>

{
  "where": {
    "status": "published",
    "category": {"$in": ["public", "internal"]},
    "created_at": {"$gte": "2024-01-01"}
  },
  "acl_update": {
    "access_read": {"$add": ["group_public", "group_employees"]},
    "access_edit": {"$add": ["group_content_managers"]},
    "access_full": {"$add": ["group_owners"]}
  }
}
```

### Bulk Permission Removal
Remove specific permissions from multiple records:

```bash
POST /api/acls/projects
Content-Type: application/json
Authorization: Bearer <jwt>

{
  "where": {"status": "archived"},
  "acl_update": {
    "access_edit": {"$remove": ["group_contractors", "group_temporary"]},
    "access_full": {"$remove": ["group_external"]}
  }
}
```

### Complete ACL Replacement
Replace all ACLs for filtered records:

```bash
PUT /api/acls/users
Content-Type: application/json
Authorization: Bearer <jwt>

{
  "where": {"department": "terminated"},
  "acl_update": {
    "access_read": ["group_hr", "group_legal"],
    "access_edit": ["group_hr_managers"],
    "access_full": ["group_owners"],
    "access_deny": ["group_terminated"]
  }
}
```

## Integration with Data API

### Automatic ACL Inheritance
Records automatically inherit ACLs from their model defaults:

```json
{
  "model_default_acls": {
    "users": {
      "access_read": ["group_public"],
      "access_edit": ["user_owner"],
      "access_full": ["group_owners"]
    }
  }
}
```

### Record Creation with ACLs
Create records with initial ACL settings:

```bash
POST /api/data/documents
Content-Type: application/json
Authorization: Bearer <jwt>

{
  "title": "Confidential Document",
  "content": "Sensitive information",
  "classification": "confidential",
  "access_read": ["group_executives", "group_legal"],
  "access_edit": ["group_legal"],
  "access_full": ["user_document_owner"]
}
```

### ACL Validation in Data Operations
Data API operations automatically validate ACL permissions:

```bash
# This will fail if user doesn't have edit permission
PUT /api/data/documents/doc_123
Authorization: Bearer <jwt>

{
  "status": "approved"
}
```

## Access Control Validation

### Permission Evaluation Order
ACL permissions are evaluated in this priority order:

1. **access_deny** - Explicit denial (highest priority)
2. **access_full** - Full control permissions
3. **access_edit** - Edit permissions
4. **access_read** - Read permissions
5. **Default Deny** - No access if no permissions match

### User vs Group Resolution
Permission resolution follows this hierarchy:

```
User Direct Permissions → Group Membership → Role-Based → Default Deny
```

### Cross-Model ACL Management
Manage ACLs across different models:

```bash
# Update ACLs for related records
POST /api/bulk
Authorization: Bearer <jwt>

{
  "operations": [
    {
      "operation": "update-one",
      "model": "users",
      "id": "user_123",
      "data": {
        "access_full": ["user_new_manager"]
      }
    },
    {
      "operation": "update-all",
      "model": "documents",
      "where": {"owner_id": "user_123"},
      "data": {
        "access_edit": {"$add": ["user_new_manager"]}
      }
    }
  ]
}
```

## Error Handling

### Common Error Responses

#### Permission Denied
```json
{
  "success": false,
  "error": {
    "type": "PermissionError",
    "message": "Admin privileges required for ACL management",
    "code": "PERMISSION_DENIED",
    "required_level": "full"
  }
}
```

#### Record Not Found
```json
{
  "success": false,
  "error": {
    "type": "NotFoundError",
    "message": "Record 'user_999999' not found in model 'users'",
    "code": "RECORD_NOT_FOUND",
    "model": "users",
    "record_id": "user_999999"
  }
}
```

#### Invalid ACL Format
```json
{
  "success": false,
  "error": {
    "type": "ValidationError",
    "message": "Invalid ACL format: User ID 'invalid_user' must be a valid UUID",
    "code": "INVALID_ACL_FORMAT",
    "field": "access_read",
    "invalid_values": ["invalid_user"]
  }
}
```

#### Bulk Operation Error
```json
{
  "success": false,
  "error": {
    "type": "BulkOperationError",
    "message": "Bulk ACL update failed for 3 records",
    "code": "BULK_OPERATION_PARTIAL_FAILURE",
    "details": {
      "total_attempted": 50,
      "successful": 47,
      "failed": 3,
      "failed_records": ["user_111", "user_222", "user_333"]
    }
  }
}
```

## Testing

The ACLs API includes comprehensive test coverage for permission management scenarios. Test files include:

- **create-acl.test.sh** - Basic ACL creation and management
- **append-acls.test.sh** - POST-based ACL merging and appending
- **update-acls.test.sh** - PUT-based ACL replacement and updates

See the test directory for detailed coverage information.

## Common Use Cases

### User Profile Privacy
Manage access to user profile information:

```json
{
  "access_read": ["group_public", "group_friends"],
  "access_edit": ["user_owner"],
  "access_full": ["user_owner"],
  "access_deny": ["user_blocked"]
}
```

### Document Access Control
Control access to sensitive documents:

```json
{
  "access_read": ["group_department", "group_legal"],
  "access_edit": ["group_document_owners", "group_legal"],
  "access_full": ["group_owners", "user_document_creator"],
  "access_deny": ["group_external", "group_contractors"]
}
```

### Project Management
Manage project-level permissions:

```json
{
  "access_read": ["group_company", "group_project_stakeholders"],
  "access_edit": ["group_project_members", "group_managers"],
  "access_full": ["group_project_leads", "group_owners"],
  "access_deny": ["group_former_employees", "group_competitors"]
}
```

### Administrative Access
Set up sudo access patterns:

```json
{
  "access_read": ["group_hr", "group_managers"],
  "access_edit": ["group_hr_managers"],
  "access_full": ["group_owners", "group_hr_directors"],
  "access_deny": ["group_terminated", "group_suspended"]
}
```

### Bulk Permission Updates
Update permissions for organizational changes:

```bash
# Grant new manager access to all team records
POST /api/acls/projects
Authorization: Bearer <jwt>

{
  "where": {"team_id": "team_123", "status": "active"},
  "acl_update": {
    "access_edit": {"$add": ["user_new_manager"]},
    "access_full": {"$add": ["user_new_manager"]}
  }
}
```

### Emergency Access Revocation
Revoke access for security incidents:

```bash
# Remove all access for compromised accounts
PUT /api/acls/users
Authorization: Bearer <jwt>

{
  "where": {"security_status": "compromised"},
  "acl_update": {
    "access_read": ["group_security", "group_legal"],
    "access_edit": ["group_security"],
    "access_full": ["group_owners"],
    "access_deny": ["group_compromised"]
  }
}
```

---

**Next: [39-Root API Documentation](39-root-api.md)** - System administration and tenant management

**Previous: [37-File API Documentation](37-file-api.md)** - Filesystem interface
