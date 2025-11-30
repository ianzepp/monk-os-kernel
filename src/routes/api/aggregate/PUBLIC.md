# Aggregate API

Perform aggregation queries on model data.

## GET /api/aggregate/:model (Shorthand)

Simple aggregations via query parameters. For complex queries, use POST.

### Query Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `count` | Count all records | `?count` |
| `sum=field` | Sum of field values | `?sum=amount` |
| `avg=field` | Average of field values | `?avg=price` |
| `min=field` | Minimum field value | `?min=created_at` |
| `max=field` | Maximum field value | `?max=updated_at` |
| `where={json}` | Filter criteria | `?where={"status":"active"}` |

### Examples

```bash
# Count all users
GET /api/aggregate/users?count

# Count active users
GET /api/aggregate/users?count&where={"status":"active"}

# Get max updated_at timestamp
GET /api/aggregate/orders?max=updated_at

# Get sum and average (multiple aggregations)
GET /api/aggregate/orders?sum=amount&avg=amount&where={"status":"paid"}
```

### Response

```json
{
  "success": true,
  "data": [
    { "count": 1523 }
  ]
}
```

---

## POST /api/aggregate/:model (Full)

Perform complex aggregation queries with multiple functions and GROUP BY support.

### Request Body

```json
{
  "where": {
    "status": "active"
  },
  "aggregate": {
    "total_count": { "$count": "*" },
    "total_revenue": { "$sum": "amount" },
    "avg_amount": { "$avg": "amount" },
    "min_amount": { "$min": "amount" },
    "max_amount": { "$max": "amount" }
  },
  "groupBy": ["country", "status"]
}
```

### Supported Aggregation Functions

- `$count` - Count records (use "*" for all records or field name for non-null values)
- `$sum` - Sum numeric values
- `$avg` - Average of numeric values  
- `$min` - Minimum value
- `$max` - Maximum value
- `$distinct` - Count distinct values

### Examples

**Simple count:**
```json
{
  "aggregate": {
    "total": { "$count": "*" }
  }
}
```

**Multiple aggregations with filter:**
```json
{
  "where": { "status": "paid" },
  "aggregate": {
    "order_count": { "$count": "*" },
    "total_revenue": { "$sum": "amount" },
    "avg_order": { "$avg": "amount" }
  }
}
```

**Group by with aggregations:**
```json
{
  "where": { "created_at": { "$gte": "2024-01-01" } },
  "aggregate": {
    "orders": { "$count": "*" },
    "revenue": { "$sum": "amount" }
  },
  "groupBy": ["country"]
}
```

### Response

```json
{
  "success": true,
  "data": [
    {
      "country": "US",
      "orders": 450,
      "revenue": 125000.50
    },
    {
      "country": "UK",
      "orders": 230,
      "revenue": 67500.25
    }
  ]
}
```
