# Kino Server API Documentation

Base URL: `/`

---

## 🔐 Authentication & Middleware

### JWT Verification
All protected routes require an `Authorization: Bearer <token>` header. The token is verified against the JWKS endpoint at `{CLIENT_URL}/api/auth/jwks`.

### Middleware Stack
| Middleware | Purpose |
|-----------|---------|
| `verifyToken` | Verifies JWT; attaches `req.user` (JWT payload) |
| `adminGuard` | Requires `role: "admin"` in DB; attaches `req.dbUser` |
| `sellerGuard` | Requires `role: "seller"` or `"admin"`; attaches `req.dbUser` |
| `buyerGuard` | Requires `role: "buyer"` or `"admin"`; attaches `req.dbUser` |

Route prefixes `/admin`, `/seller`, and `/buyer` have their middleware applied globally via `app.use()`.

---

## 📡 Public Routes

### Health Check
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/` | Server health check |

### Stats
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/stats` | Public marketplace stats (products, orders, sellers, buyers) |

**GET `/stats` Response:**
```json
{
  "success": true,
  "result": {
    "totalProducts": 120,
    "totalOrders": 45,
    "totalSellers": 30,
    "totalBuyers": 200
  }
}
```

### Top Sellers
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/sellers/top` | Top sellers ranked by product count |

**Query Parameters:**
- `limit` (number): Max results (default: 3, max: 10)

**Response:**
```json
{
  "success": true,
  "result": [
    { "_id": "...", "name": "Alice", "email": "...", "image": "...", "location": {}, "productCount": 12 }
  ]
}
```

### Products
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/products` | List products with filters and pagination |
| `GET` | `/products/:id` | Get a single product by ID |

**GET `/products` Query Parameters:**
- `page` (number): Page number (default: 1)
- `limit` (number): Items per page (default: 10, max: 100)
- `search` (string): Filter by title (case-insensitive)
- `category` (string): Filter by category
- `status` (string): Filter by status
- `condition` (string): Filter by condition
- `sort` (string): Field to sort by (`price`, `dateUploaded`)
- `order` (string): Sort direction (`asc`, `desc`)

**GET `/products` Response:**
```json
{
  "success": true,
  "message": "Products loaded successfully",
  "result": [ { "...": "..." } ],
  "total": 120,
  "page": 1,
  "limit": 10
}
```

**GET `/products/:id` Response:**
```json
{ "success": true, "message": "Product info loaded", "result": { "...": "..." } }
```

### Reviews
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/reviews` | Latest reviews (public) |
| `GET` | `/reviews/:productId` | Reviews for a specific product |

**GET `/reviews` Query Parameters:**
- `limit` (number): Max results (default: 6, max: 50)

---

## 🔒 Admin Routes

> **Auth:** `verifyToken` + `adminGuard` (applied to all `/admin` routes)

### Statistics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/stats/users` | Total user count |
| `GET` | `/admin/stats/products` | Total product count |
| `GET` | `/admin/stats/orders` | Total order count |
| `GET` | `/admin/stats/revenue` | Total revenue from successful payments |
| `GET` | `/admin/stats/revenue-by-month` | Revenue grouped by month |

**Stats Response (users / products / orders):**
```json
{ "success": true, "result": { "total": 123 } }
```

**Revenue Response:**
```json
{ "success": true, "result": { "totalRevenue": 50000 } }
```

### Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/analytics` | Full analytics (orders, categories, users, revenue) |
| `GET` | `/admin/analytics/summary` | Summary counts + total revenue |

**GET `/admin/analytics` Response:**
```json
{
  "success": true,
  "result": {
    "monthlyOrders": [ { "month": "2024-01", "count": 15 } ],
    "categoryPerformance": [ { "category": "Electronics", "count": 45 } ],
    "userGrowth": [ { "role": "seller", "count": 30 } ],
    "revenueByMonth": [ { "month": "2024-01-15", "revenue": 5000 } ]
  }
}
```

**GET `/admin/analytics/summary` Response:**
```json
{
  "success": true,
  "result": { "totalOrders": 45, "totalProducts": 120, "totalUsers": 230, "totalRevenue": 50000 }
}
```

### User Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/users` | List all users with filters and pagination |
| `PATCH` | `/admin/users/:userId` | Update user fields (name, role, location, contact) |
| `PATCH` | `/admin/users/:userId/status` | Update user status |
| `DELETE` | `/admin/users/:userId` | Delete a user |

**GET `/admin/users` Query Parameters:**
- `page`, `limit`, `sort`, `order`, `search`, `role`, `status`

**PATCH `/admin/users/:userId` Body:**
```json
{ "name": "Alice", "role": "seller", "location": {}, "contact": {} }
```

**PATCH `/admin/users/:userId/status` Body:**
```json
{ "status": "banned" }
```

### Product Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/products` | List all products with filters and pagination |
| `PATCH` | `/admin/products/:productId` | Update product fields |
| `PATCH` | `/admin/products/:productId/status` | Update product status |
| `DELETE` | `/admin/products/:productId` | Delete a product |

**GET `/admin/products` Query Parameters:**
- `page`, `limit`, `search`, `category`, `status`

**PATCH `/admin/products/:productId` Body:**
```json
{ "title": "...", "category": "...", "condition": "...", "price": 100, "description": "..." }
```

### Order Management
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/orders` | List all orders with filters and pagination |
| `PATCH` | `/admin/orders/:orderId/status` | Update order status |

**GET `/admin/orders` Query Parameters:**
- `page`, `limit`, `search` (buyer name/email), `status`

**PATCH `/admin/orders/:orderId/status` Body:**
```json
{ "status": "shipped" }
```

### Payment Monitoring
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/admin/payments` | List all payments with filters and pagination |

**GET `/admin/payments` Query Parameters:**
- `page`, `limit`, `status`, `search` (buyer email, seller email, transactionId)

---

## 🏪 Seller Routes

> **Auth:** `verifyToken` + `sellerGuard` (applied to all `/seller` routes)
> Sellers can only access/modify their own products and orders.

### Products
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/seller/products` | List seller's own products |
| `POST` | `/seller/products` | Create a new product |
| `PATCH` | `/seller/products/:id` | Update seller's own product |
| `DELETE` | `/seller/products/:id` | Delete seller's own product |

**POST `/seller/products` Body:**
```json
{ "title": "...", "category": "...", "condition": "...", "price": 100, "description": "...", "image": "..." }
```
Fields `sellerEmail`, `sellerName`, `status`, `dateUploaded`, and `createdAt` are set automatically.

### Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/seller/orders` | List orders for seller's products |
| `PATCH` | `/seller/orders/:id/status` | Update status of seller's order |

**GET `/seller/orders` Query Parameters:**
- `page`, `limit`, `search` (buyer name/email), `status`

**PATCH `/seller/orders/:id/status` Body:**
```json
{ "status": "shipped" }
```

### Stats & Analytics
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/seller/stats` | Seller's product count, order count, revenue, pending orders |
| `GET` | `/seller/analytics` | Monthly sales and top products |

**GET `/seller/stats` Response:**
```json
{
  "success": true,
  "result": { "totalProducts": 10, "totalOrders": 25, "totalRevenue": 12000, "pendingOrders": 3 }
}
```

**GET `/seller/analytics` Response:**
```json
{
  "success": true,
  "result": {
    "monthlySales": [ { "month": "2024-01", "count": 5 } ],
    "topProducts": [ { "...": "..." } ]
  }
}
```

---

## 🛍️ Buyer Routes

> **Auth:** `verifyToken` + `buyerGuard` (applied to all `/buyer` routes)

### Orders
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/buyer/orders` | List buyer's own orders |
| `PATCH` | `/buyer/orders/:id/cancel` | Cancel a pending order |

**GET `/buyer/orders` Query Parameters:**
- `page`, `limit`, `status`

Cancellation only works if `orderStatus` is `"pending"`.

### Stats
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/buyer/stats` | Buyer's order count, wishlist count, recent purchases |

**GET `/buyer/stats` Response:**
```json
{
  "success": true,
  "result": { "totalOrders": 8, "wishlistCount": 5, "recentPurchases": [ { "...": "..." } ] }
}
```

---

## ❤️ Wishlist Routes

> **Auth:** `verifyToken` only (any authenticated user)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/wishlist` | Get wishlist products for logged-in user |
| `POST` | `/wishlist/:productId` | Add a product to wishlist |
| `DELETE` | `/wishlist/:productId` | Remove a product from wishlist |

**GET `/wishlist` Response:**
```json
{ "success": true, "result": [ { "product": "..." } ] }
```

**POST / DELETE Response:**
```json
{ "success": true, "message": "Added to wishlist", "result": null }
```

---

## 👤 Profile Routes

> **Auth:** `verifyToken` only (any authenticated user)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/profile` | Get logged-in user's profile |
| `PATCH` | `/profile` | Update profile fields |

**PATCH `/profile` Body (all fields optional):**
```json
{ "name": "Alice", "contact": {}, "location": {}, "image": "https://..." }
```

Password is never returned in profile responses.

---

## 💳 Payment Routes

> **Auth:** `verifyToken` + `buyerGuard`

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/payments/create-intent` | Create a Stripe PaymentIntent |
| `POST` | `/payments/confirm` | Confirm payment, create order and payment record |
| `GET` | `/payments/my-history` | Buyer's payment history |

**POST `/payments/create-intent` Body:**
```json
{ "amount": 150, "productId": "...", "productTitle": "..." }
```
Amount is in your currency unit (converted to smallest unit for Stripe automatically). Currency: `bdt`.

**POST `/payments/create-intent` Response:**
```json
{ "success": true, "result": { "clientSecret": "pi_...secret_..." } }
```

**POST `/payments/confirm` Body:**
```json
{ "transactionId": "pi_...", "productId": "...", "sellerEmail": "seller@example.com", "amount": 150, "productTitle": "..." }
```

On success:
1. Verifies the PaymentIntent with Stripe
2. Guards against duplicate payment (returns 409 if already recorded)
3. Creates an order in `orders` collection
4. Creates a payment record in `payments` collection
5. Marks the product as `sold`

**POST `/payments/confirm` Response:**
```json
{ "success": true, "message": "Order and payment saved", "result": { "orderId": "..." } }
```

**GET `/payments/my-history` Query Parameters:**
- `page`, `limit`, `status`

---

## ⭐ Review Routes

| Method | Endpoint | Auth | Description |
|--------|----------|------|-------------|
| `GET` | `/reviews` | ❌ | Latest reviews (public) |
| `GET` | `/reviews/:productId` | ❌ | Reviews for a product |
| `POST` | `/reviews` | `verifyToken` + `buyerGuard` | Submit a review |

**POST `/reviews` Body:**
```json
{ "productId": "...", "rating": 5, "comment": "Great product!" }
```

- `rating` is clamped to 1–5.
- One review per buyer per product (returns 409 on duplicate).

**Review Document Schema:**
```json
{
  "productId": "...",
  "buyerEmail": "buyer@example.com",
  "buyerName": "Alice",
  "rating": 5,
  "comment": "Great product!",
  "createdAt": "2024-01-15T10:00:00Z"
}
```

---

## 📤 Upload Routes

> **Auth:** `verifyToken` (any authenticated user)

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/upload` | Upload an image to Cloudinary |
| `DELETE` | `/upload/*publicId` | Delete an image from Cloudinary |

**POST `/upload` Headers:**
- `Content-Type`: MIME type of the image (e.g. `image/jpeg`)
- `x-upload-folder`: Cloudinary folder (default: `Kino.com`)
- `x-upload-filename`: Original file name (default: `upload`)
- Body: raw binary image data

**POST `/upload` Response:**
```json
{ "success": true, "result": { "url": "https://res.cloudinary.com/...", "public_id": "...", "isDuplicate": false } }
```

- SHA-256 deduplication: identical files return the existing URL immediately (`isDuplicate: true`).
- Images are transformed to max 1200×900, auto quality, auto format.

**DELETE `/upload/*publicId`**
- `publicId` may contain slashes (e.g. `Kino.com/products/abc123`).
- Only the uploader can delete their own image (returns 403 otherwise).

---

## 📋 Full Route Summary

| Method | Endpoint | Auth | Role |
|--------|----------|------|------|
| `GET` | `/` | ❌ | — |
| `GET` | `/stats` | ❌ | — |
| `GET` | `/sellers/top` | ❌ | — |
| `GET` | `/products` | ❌ | — |
| `GET` | `/products/:id` | ❌ | — |
| `GET` | `/reviews` | ❌ | — |
| `GET` | `/reviews/:productId` | ❌ | — |
| `POST` | `/reviews` | ✅ | buyer/admin |
| `GET` | `/admin/stats/users` | ✅ | admin |
| `GET` | `/admin/stats/products` | ✅ | admin |
| `GET` | `/admin/stats/orders` | ✅ | admin |
| `GET` | `/admin/stats/revenue` | ✅ | admin |
| `GET` | `/admin/stats/revenue-by-month` | ✅ | admin |
| `GET` | `/admin/analytics` | ✅ | admin |
| `GET` | `/admin/analytics/summary` | ✅ | admin |
| `GET` | `/admin/users` | ✅ | admin |
| `PATCH` | `/admin/users/:userId` | ✅ | admin |
| `PATCH` | `/admin/users/:userId/status` | ✅ | admin |
| `DELETE` | `/admin/users/:userId` | ✅ | admin |
| `GET` | `/admin/products` | ✅ | admin |
| `PATCH` | `/admin/products/:productId` | ✅ | admin |
| `PATCH` | `/admin/products/:productId/status` | ✅ | admin |
| `DELETE` | `/admin/products/:productId` | ✅ | admin |
| `GET` | `/admin/orders` | ✅ | admin |
| `PATCH` | `/admin/orders/:orderId/status` | ✅ | admin |
| `GET` | `/admin/payments` | ✅ | admin |
| `GET` | `/seller/products` | ✅ | seller/admin |
| `POST` | `/seller/products` | ✅ | seller/admin |
| `PATCH` | `/seller/products/:id` | ✅ | seller/admin |
| `DELETE` | `/seller/products/:id` | ✅ | seller/admin |
| `GET` | `/seller/orders` | ✅ | seller/admin |
| `PATCH` | `/seller/orders/:id/status` | ✅ | seller/admin |
| `GET` | `/seller/stats` | ✅ | seller/admin |
| `GET` | `/seller/analytics` | ✅ | seller/admin |
| `GET` | `/buyer/orders` | ✅ | buyer/admin |
| `PATCH` | `/buyer/orders/:id/cancel` | ✅ | buyer/admin |
| `GET` | `/buyer/stats` | ✅ | buyer/admin |
| `GET` | `/wishlist` | ✅ | any |
| `POST` | `/wishlist/:productId` | ✅ | any |
| `DELETE` | `/wishlist/:productId` | ✅ | any |
| `GET` | `/profile` | ✅ | any |
| `PATCH` | `/profile` | ✅ | any |
| `POST` | `/payments/create-intent` | ✅ | buyer/admin |
| `POST` | `/payments/confirm` | ✅ | buyer/admin |
| `GET` | `/payments/my-history` | ✅ | buyer/admin |
| `POST` | `/upload` | ✅ | any |
| `DELETE` | `/upload/*publicId` | ✅ | any (owner only) |

---

## 🗄️ Database

- **MongoDB database:** `kino_main`
- **Collections:** `user`, `products`, `orders`, `payments`, `reviews`, `cloudinary_uploads`
- All list endpoints support `page` and `limit` pagination; responses include `total`.
- All IDs are validated as MongoDB ObjectIds before use (returns 400 on invalid format).
