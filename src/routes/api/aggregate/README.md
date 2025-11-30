# 34-Aggregate API Documentation

> **Data Aggregation and Analytics**
>
> The Aggregate API provides enterprise-grade aggregation capabilities including COUNT, SUM, AVG, MIN, MAX with GROUP BY support. Enables dashboards, reports, and analytics without fetching all records.

## Table of Contents

1. [Overview](#overview)
2. [Authentication](#authentication)
3. [Core Endpoint](#core-endpoint)
4. [Aggregation Functions](#aggregation-functions)
5. [GROUP BY Operations](#group-by-operations)
6. [Filtering with Aggregations](#filtering-with-aggregations)
7. [Soft Delete Integration](#soft-delete-integration)
8. [Performance Considerations](#performance-considerations)
9. [Error Handling](#error-handling)
10. [Common Use Cases](#common-use-cases)

## Overview

The Aggregate API provides powerful data aggregation capabilities for analytics, dashboards, and reporting. It executes server-side aggregations using PostgreSQL's native aggregation functions, enabling efficient computation over large datasets without transferring all records to the client.

### Key Capabilities
- **6 Aggregation Functions**: COUNT, SUM, AVG, MIN, MAX, COUNT DISTINCT
- **GROUP BY Support**: Single or multiple field grouping
- **Filter Integration**: Full WHERE clause support from Find API (25+ operators)
- **Soft Delete Aware**: Automatic filtering of deleted records
- **ACL Integration**: Respects access control lists
- **Performance Optimized**: Server-side aggregation with index usage

### Base URL
```
POST /api/aggregate/:model
```

## Authentication

All Aggregate API endpoints require valid JWT authentication. The API respects tenant isolation and record-level permissions.

```bash
Authorization: Bearer <jwt>
```

### Required Permissions
- **Read Access**: `read_data` permission required for aggregations
- **ACL Filtering**: Aggregations automatically filtered by `access_read` arrays

## Core Endpoint

### POST /api/aggregate/:model

Execute aggregation queries with optional GROUP BY and WHERE clauses.

**Basic Request:**
```bash
POST /api/aggregate/orders
Content-Type: application/json
Authorization: Bearer <jwt>

{
  "aggregate": {
    "total": {"$count": "*"}
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "total": 1547
    }
  ]
}
```

## Aggregation Functions

### $count - Count Records

Count all records or non-null values in a specific field.

**Count all records:**
```json
{
  "aggregate": {
    "total_orders": {"$count": "*"}
  }
}
```

**Count non-null values:**
```json
{
  "aggregate": {
    "completed_orders": {"$count": "completed_at"}
  }
}
```

### $sum - Sum Numeric Values

Calculate the sum of a numeric field.

```json
{
  "aggregate": {
    "total_revenue": {"$sum": "amount"}
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "total_revenue": 125750.50
    }
  ]
}
```

### $avg - Average Numeric Values

Calculate the average of a numeric field.

```json
{
  "aggregate": {
    "average_order_value": {"$avg": "amount"}
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "average_order_value": 81.27
    }
  ]
}
```

### $min - Minimum Value

Find the minimum value in a field.

```json
{
  "aggregate": {
    "smallest_order": {"$min": "amount"},
    "earliest_date": {"$min": "created_at"}
  }
}
```

### $max - Maximum Value

Find the maximum value in a field.

```json
{
  "aggregate": {
    "largest_order": {"$max": "amount"},
    "latest_date": {"$max": "created_at"}
  }
}
```

### $distinct - Count Distinct Values

Count unique values in a field.

```json
{
  "aggregate": {
    "unique_customers": {"$distinct": "customer_id"},
    "unique_products": {"$distinct": "product_id"}
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "unique_customers": 342,
      "unique_products": 89
    }
  ]
}
```

## GROUP BY Operations

### Single Field Grouping

Group aggregations by a single field.

**Request:**
```json
{
  "aggregate": {
    "order_count": {"$count": "*"},
    "total_revenue": {"$sum": "amount"}
  },
  "groupBy": ["status"]
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "status": "completed",
      "order_count": 1247,
      "total_revenue": 98750.25
    },
    {
      "status": "pending",
      "order_count": 183,
      "total_revenue": 14230.50
    },
    {
      "status": "cancelled",
      "order_count": 117,
      "total_revenue": 12769.75
    }
  ]
}
```

### Multiple Field Grouping

Group by multiple fields for deeper analysis.

**Request:**
```json
{
  "aggregate": {
    "orders": {"$count": "*"},
    "revenue": {"$sum": "amount"}
  },
  "groupBy": ["country", "status"]
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "country": "US",
      "status": "completed",
      "orders": 756,
      "revenue": 62450.00
    },
    {
      "country": "US",
      "status": "pending",
      "orders": 89,
      "revenue": 7120.50
    },
    {
      "country": "UK",
      "status": "completed",
      "orders": 491,
      "revenue": 36300.25
    }
  ]
}
```

## Filtering with Aggregations

### Basic WHERE Filtering

Combine aggregations with WHERE clauses to filter data before aggregation.

**Request:**
```json
{
  "where": {
    "status": "completed",
    "created_at": {"$gte": "2024-01-01"}
  },
  "aggregate": {
    "total_orders": {"$count": "*"},
    "total_revenue": {"$sum": "amount"},
    "avg_order_value": {"$avg": "amount"}
  }
}
```

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "total_orders": 1247,
      "total_revenue": 98750.25,
      "avg_order_value": 79.19
    }
  ]
}
```

### Complex Filters with GROUP BY

Use advanced filtering operators with grouping.

**Request:**
```json
{
  "where": {
    "amount": {"$gte": 100},
    "status": {"$in": ["completed", "shipped"]},
    "created_at": {"$between": ["2024-01-01", "2024-12-31"]}
  },
  "aggregate": {
    "high_value_orders": {"$count": "*"},
    "total_revenue": {"$sum": "amount"}
  },
  "groupBy": ["country"]
}
```

### ACL Filtering

Aggregations automatically respect access control lists.

```json
{
  "where": {
    "access_read": {"$any": ["user-123", "group-456"]}
  },
  "aggregate": {
    "accessible_records": {"$count": "*"}
  }
}
```

## Soft Delete Integration

### Automatic Exclusion

By default, aggregations exclude soft-deleted records (trashed_at IS NOT NULL).

**Request:**
```json
{
  "aggregate": {
    "active_users": {"$count": "*"}
  }
}
```

This automatically adds: `WHERE trashed_at IS NULL AND deleted_at IS NULL`

### Including Trashed Records

Use context options to include soft-deleted records in aggregations.

**Request:**
```json
{
  "aggregate": {
    "all_users": {"$count": "*"}
  },
  "context": "system"
}
```

**Context Options:**
- `api` (default): Excludes trashed and deleted records
- `observer`: Includes trashed, excludes deleted
- `system`: Includes all records

## Performance Considerations

### Index Usage

Aggregations benefit from indexes on:
- **WHERE clause fields**: For filtering before aggregation
- **GROUP BY fields**: For grouping operations
- **Aggregated fields**: For SUM, AVG, MIN, MAX operations

**Example indexes:**
```sql
CREATE INDEX idx_orders_status ON orders(status);
CREATE INDEX idx_orders_country_status ON orders(country, status);
CREATE INDEX idx_orders_created_at ON orders(created_at);
```

### Query Optimization

**Best Practices:**
1. **Filter First**: Use WHERE clauses to reduce dataset size
2. **Index GROUP BY Fields**: Speeds up grouping operations
3. **Limit GROUP BY**: Avoid grouping by high-cardinality fields
4. **Use COUNT(*)**: Faster than COUNT(field) when possible

**Performance Tips:**
```json
{
  "where": {"status": "active"},  // Filter first
  "aggregate": {
    "total": {"$count": "*"}      // COUNT(*) is faster
  },
  "groupBy": ["country"]           // Index on country
}
```

### Limitations

- **No nested aggregations**: Cannot compute AVG(SUM(x))
- **GROUP BY cardinality**: Very high cardinality (millions of unique values) may be slow
- **Result size**: Large GROUP BY results may need pagination (future enhancement)

## Error Handling

### Common Error Responses

#### Missing Aggregations

```json
{
  "success": false,
  "error": "Request must include \"aggregate\" object with at least one aggregation function",
  "error_code": "REQUEST_MISSING_AGGREGATIONS"
}
```

#### Invalid Aggregation Function

```json
{
  "success": false,
  "error": "Unknown aggregation function for alias 'total'",
  "error_code": "FILTER_INVALID_AGGREGATION"
}
```

#### Invalid Field Name

```json
{
  "success": false,
  "error": "Invalid field name format: invalid-field-name",
  "error_code": "FILTER_INVALID_FIELD_FORMAT"
}
```

#### Permission Error

```json
{
  "success": false,
  "error": "Insufficient permissions to read model",
  "error_code": "INSUFFICIENT_PERMISSIONS"
}
```

## Common Use Cases

### Dashboard Metrics

**Order statistics by status:**
```json
{
  "aggregate": {
    "total_orders": {"$count": "*"},
    "total_revenue": {"$sum": "amount"},
    "avg_order_value": {"$avg": "amount"}
  },
  "groupBy": ["status"]
}
```

### Financial Reports

**Monthly revenue report:**
```json
{
  "where": {
    "status": "paid",
    "created_at": {"$gte": "2024-01-01"}
  },
  "aggregate": {
    "total_revenue": {"$sum": "amount"},
    "transaction_count": {"$count": "*"},
    "avg_transaction": {"$avg": "amount"}
  },
  "groupBy": ["EXTRACT(MONTH FROM created_at)"]
}
```

### Customer Analytics

**Customer engagement metrics:**
```json
{
  "aggregate": {
    "total_customers": {"$distinct": "customer_id"},
    "total_orders": {"$count": "*"},
    "total_revenue": {"$sum": "amount"},
    "avg_order_per_customer": {"$avg": "amount"}
  },
  "groupBy": ["country"]
}
```

### Inventory Management

**Stock levels by warehouse:**
```json
{
  "where": {
    "status": "in_stock"
  },
  "aggregate": {
    "total_items": {"$sum": "quantity"},
    "unique_products": {"$distinct": "product_id"},
    "avg_stock_level": {"$avg": "quantity"},
    "min_stock": {"$min": "quantity"},
    "max_stock": {"$max": "quantity"}
  },
  "groupBy": ["warehouse_id"]
}
```

### User Activity Analysis

**User activity by time period:**
```json
{
  "where": {
    "created_at": {"$gte": "2024-01-01"}
  },
  "aggregate": {
    "active_users": {"$distinct": "user_id"},
    "total_actions": {"$count": "*"}
  },
  "groupBy": ["DATE_TRUNC('day', created_at)"]
}
```

## Testing

For comprehensive testing information, see:
- **[spec/34-aggregate-api/README.md](../spec/34-aggregate-api/README.md)** - Test suite documentation
- **[spec/34-aggregate-api/basic-count.test.sh](../spec/34-aggregate-api/basic-count.test.sh)** - Basic aggregation tests
- **[spec/34-aggregate-api/group-by-basic.test.sh](../spec/34-aggregate-api/group-by-basic.test.sh)** - GROUP BY tests

## Summary

The Aggregate API provides production-ready aggregation capabilities:

**Key Features:**
- ✅ 6 aggregation functions (COUNT, SUM, AVG, MIN, MAX, DISTINCT)
- ✅ Single and multiple field GROUP BY
- ✅ Full WHERE clause filtering (25+ operators)
- ✅ Soft delete integration
- ✅ ACL filtering
- ✅ Server-side processing for performance

**Integration:**
- Shares filtering syntax with Find API
- Uses same authentication and permissions
- Respects tenant isolation
- Automatic soft delete handling

**Performance:**
- Leverages PostgreSQL native aggregations
- Supports index usage for optimization
- No data transfer overhead
- Efficient for large datasets

---

**Next: [35-Bulk API Documentation](35-bulk-api.md)** - Transaction-safe bulk operations

**Previous: [33-Find API Documentation](33-find-api.md)** - Advanced filtering and search
