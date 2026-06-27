# Kino Server API Documentation

Base URL: `/`

---

## 📡 Public Routes

### Health & Status
| Method | Endpoint | Description | Middleware |
|--------|----------|-------------|------------|
| `GET`  |    `/`   | Server health check | None |

**Response:**
```json
{ "message": "Kino.com server has started" }
```

---

### Products
| Method | Endpoint | Description | Middleware |
|--------|----------|-------------|------------|
| `GET`  | `/products` | Get all products with filters | None |
| `GET`  | `/products/:id` | Get a single product by ID | None |

#### GET `/products`
**Query Parameters:**
- `sort` (string): Field to sort by (`price`, `dateUploaded`)
- `order` (string): Sort order (`asc`, `desc`)
- `limit` (number): Maximum results to return
- `search` (string): Search by product title (case-insensitive)
- `category` (string): Filter by category
- `status` (string): Filter by status
- `condition` (string): Filter by condition

**Response:**
```json
{
  "success": true,
  "message": "Products are loaded successfully",
  "result": [ { "product": "..." } ]
}
```

#### GET `/products/:id`
**Parameters:**
- `id` (string, required): MongoDB ObjectId of the product

**Response:**
```json
{
  "success": true,
  "message": "Product info loaded",
  "result": { "product": "..." }
}
```

---

## 🔒 Admin Routes

> **Note:** All admin routes require:
> - `Authorization: Bearer <token>` header
> - Valid JWT token
> - User must have `role: "admin"` (case-insensitive)
>
> **Middleware Stack:** `verifyToken` → `adminGuard`

---

### 📊 Statistics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET`  | `/admin/stats/users` | Total user count |
| `GET`  | `/admin/stats/products` | Total product count |
| `GET`  | `/admin/stats/orders` | Total order count |

**Response (all stats endpoints):**
```json
{ "success": true, "result": { "total": 123 } }
```

---

### 👥 User Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/users` | List all users with pagination |
| `PATCH` | `/admin/users/:userId/status` | Update user status |
| `DELETE` | `/admin/users/:userId` | Delete a user |

#### GET `/admin/users`
**Query Parameters:**
- `page` (number): Page number (default: 1)
- `limit` (number): Items per page (default: 10)
- `search` (string): Search by user name
- `role` (string): Filter by role
- `status` (string): Filter by status
- `sort` (string): Field to sort by
- `order` (string): Sort order (`asc`, `desc`)

**Response:**
```json
{
  "success": true,
  "result": [ { "user": "..." } ],
  "total": 100
}
```

#### PATCH `/admin/users/:userId/status`
**Parameters:**
- `userId` (string, required): MongoDB ObjectId

**Request Body:**
```json
{ "status": "active" }
```

**Response:**
```json
{
  "success": true,
  "message": "User status updated",
  "result": { "matchedCount": 1, "modifiedCount": 1 }
}
```

#### DELETE `/admin/users/:userId`
**Parameters:**
- `userId` (string, required): MongoDB ObjectId

**Response:**
```json
{ "success": true, "message": "User deleted", "result": null }
```

---

### 📦 Product Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/products` | List all products with pagination |
| `PATCH` | `/admin/products/:productId/status` | Update product status |
| `DELETE` | `/admin/products/:productId` | Delete a product |

#### GET `/admin/products`
**Query Parameters:**
- `page` (number): Page number (default: 1)
- `limit` (number): Items per page (default: 10)
- `search` (string): Search by product title
- `category` (string): Filter by category
- `status` (string): Filter by status

**Response:**
```json
{
  "success": true,
  "result": [ { "product": "..." } ],
  "total": 50
}
```

#### PATCH `/admin/products/:productId/status`
**Parameters:**
- `productId` (string, required): MongoDB ObjectId

**Request Body:**
```json
{ "status": "active" }
```

**Response:**
```json
{
  "success": true,
  "message": "Product status updated",
  "result": { "matchedCount": 1, "modifiedCount": 1 }
}
```

#### DELETE `/admin/products/:productId`
**Parameters:**
- `productId` (string, required): MongoDB ObjectId

**Response:**
```json
{ "success": true, "message": "Product deleted", "result": null }
```

---

### 🛒 Order Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/orders` | List all orders with pagination |
| `PATCH` | `/admin/orders/:orderId/status` | Update order status |

#### GET `/admin/orders`
**Query Parameters:**
- `page` (number): Page number (default: 1)
- `limit` (number): Items per page (default: 10)
- `search` (string): Search by buyer name or email
- `status` (string): Filter by order status

**Response:**
```json
{
  "success": true,
  "result": [ { "order": "..." } ],
  "total": 25
}
```

#### PATCH `/admin/orders/:orderId/status`
**Parameters:**
- `orderId` (string, required): MongoDB ObjectId

**Request Body:**
```json
{ "status": "shipped" }
```

**Response:**
```json
{
  "success": true,
  "message": "Order status updated",
  "result": { "matchedCount": 1, "modifiedCount": 1 }
}
```

---

### 📈 Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/analytics` | Get comprehensive analytics data |

**Response:**
```json
{
  "success": true,
  "result": {
    "monthlyOrders": [ { "month": "2024-01", "count": 15 } ],
    "categoryPerformance": [ { "category": "Electronics", "count": 45 } ],
    "userGrowth": [ { "role": "admin", "count": 2 } ],
    "revenueByMonth": [ { "month": "2024-01", "revenue": 5000 } ]
  }
}
```

---

## 🔐 Authentication & Middleware

### Middleware Functions
- **`verifyToken`**: Verifies JWT token from `Authorization: Bearer <token>` header
- **`adminGuard`**: Checks if authenticated user has admin role (case-insensitive)

### JWT Configuration
- Uses JWKS from: `{CLIENT_URL}/api/auth/jwks`
- Supports both development (`http://localhost:3000`) and production environments

---

## 📋 Route Summary Table

| Method | Endpoint | Auth Required | Description |
|--------|----------|---------------|-------------|
| `GET` | `/` | ❌ | Server health check |
| `GET` | `/products` | ❌ | List products |
| `GET` | `/products/:id` | ❌ | Get product by ID |
| `GET` | `/admin/stats/users` | ✅ | User count |
| `GET` | `/admin/stats/products` | ✅ | Product count |
| `GET` | `/admin/stats/orders` | ✅ | Order count |
| `GET` | `/admin/users` | ✅ | List users |
| `PATCH` | `/admin/users/:userId/status` | ✅ | Update user status |
| `DELETE` | `/admin/users/:userId` | ✅ | Delete user |
| `GET` | `/admin/products` | ✅ | List products |
| `PATCH` | `/admin/products/:productId/status` | ✅ | Update product status |
| `DELETE` | `/admin/products/:productId` | ✅ | Delete product |
| `GET` | `/admin/orders` | ✅ | List orders |
| `PATCH` | `/admin/orders/:orderId/status` | ✅ | Update order status |
| `GET` | `/admin/analytics` | ✅ | Get analytics |

---

## 💡 Notes

- All admin routes are prefixed with `/admin` and protected by `verifyToken` + `adminGuard`
- Database: MongoDB (`kino_main` database)
- Collections used: `user`, `products`, `orders`, `payments`
- All DELETE and PATCH operations return modification results
- All list endpoints support pagination via `page` and `limit` query parameters