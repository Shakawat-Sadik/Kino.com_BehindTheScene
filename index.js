//pnpm add express mongodb jose cors dotenv cloudinary
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { v2 as cloudinary } from "cloudinary";
import crypto from "crypto";
import Stripe from "stripe";

dotenv.config();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true,
});

const app = express();
const port = process.env.PORT || 5000;

const uri = process.env.MONGODB_URI;
const url =
  process.env.NODE_ENV === "production"
    ? process.env.CLIENT_URL
    : "http://localhost:3000";

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const JWKS = createRemoteJWKSet(new URL(`${url}/api/auth/jwks`));

app.use(
  cors({
    origin: [
      "http://localhost:3000",
      process.env.CLIENT_URL,
    ].filter(Boolean),
    credentials: true,
  }),
);
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// ==========================================
// DB CONNECTION (with race condition fix)
// ==========================================

let cacheDB = null;
let connectPromise = null;

const connectToDB = async () => {
  if (cacheDB) return cacheDB;

  // ✅ Fix: Reuse same promise if connection is in progress
  if (!connectPromise) {
    connectPromise = (async () => {
      try {
        await client.connect();
        cacheDB = await client.db("kino_main");
        return cacheDB;
      } catch (e) {
        connectPromise = null; // Allow retry on failure
        throw e;
      }
    })();
  }

  return connectPromise;
};

// Make DB available in all routes
app.use(async (req, res, next) => {
  try {
    req.db = await connectToDB();
    next();
  } catch (e) {
    res.status(503).json({ success: false, message: "Database unavailable" });
  }
});

// ==========================================
// HELPERS
// ==========================================

// ✅ Fix: Validate ObjectId before using it
const isValidObjectId = (id) => {
  try {
    return ObjectId.isValid(id) && new ObjectId(id).toString() === id;
  } catch {
    return false;
  }
};

const parsePagination = (query) => {
  const page = Math.max(1, parseInt(query.page, 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(query.limit, 10) || 10));
  return { page, limit, skip: (page - 1) * limit };
};

// Safe error response (no leaks in production)
const sendError = (res, statusCode, message, error = null) => {
  if (error) console.error(`[${message}]`, error);
  res.status(statusCode).json({
    success: false,
    message: process.env.NODE_ENV === "development" && error ? error.message : message,
  });
};

// ==========================================
// MIDDLEWARE
// ==========================================

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return res.status(401).json({ success: false, message: "Unauthorized entry" });
    }
    const token = authHeader.split(" ")[1];
    try {
      const { payload } = await jwtVerify(token, JWKS);
      req.user = payload;
      next();
    } catch (e) {
      return res.status(403).json({ success: false, message: "Invalid or expired token" });
    }
  } catch (e) {
    return res.status(401).json({ success: false, message: "Authentication error" });
  }
};

const adminGuard = async (req, res, next) => {
  try {
    if (!req.user?.email) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    const user = await req.db.collection("user").findOne({
      email: req.user.email,
      role: "admin",
    });
    if (!user) {
      return res.status(403).json({ success: false, message: "Forbidden: Admins only" });
    }
    req.dbUser = user;
    next();
  } catch (error) {
    sendError(res, 500, "Authorization check failed", error);
  }
};

const sellerGuard = async (req, res, next) => {
  try {
    if (!req.user?.email) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    const user = await req.db.collection("user").findOne({ email: req.user.email });
    if (!user || !["seller", "admin"].includes(user.role?.toLowerCase())) {
      return res.status(403).json({ success: false, message: "Forbidden: Sellers and Admins only" });
    }
    req.dbUser = user;
    next();
  } catch (error) {
    sendError(res, 500, "Authorization check failed", error);
  }
};

const buyerGuard = async (req, res, next) => {
  try {
    if (!req.user?.email) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    const user = await req.db.collection("user").findOne({ email: req.user.email });
    if (!user || !["buyer", "admin"].includes(user.role?.toLowerCase())) {
      return res.status(403).json({ success: false, message: "Forbidden: Buyers and Admins only" });
    }
    req.dbUser = user;
    next();
  } catch (error) {
    sendError(res, 500, "Authorization check failed", error);
  }
};

// ==========================================
// PUBLIC ROUTES
// ==========================================

app.get("/", (req, res) => {
  res.json({ message: "Kino.com server has started" });
});

// ✅ NEW: Public marketplace stats (for home page)
app.get("/stats", async (req, res) => {
  try {
    const [totalProducts, totalOrders, sellers, buyers] = await Promise.all([
      req.db.collection("products").countDocuments(),
      req.db.collection("orders").countDocuments(),
      req.db.collection("user").countDocuments({ role: "seller" }),
      req.db.collection("user").countDocuments({ role: "buyer" }),
    ]);
    res.status(200).json({
      success: true,
      result: { totalProducts, totalOrders, totalSellers: sellers, totalBuyers: buyers },
    });
  } catch (e) {
    sendError(res, 500, "Failed to fetch stats", e);
  }
});

// ✅ NEW: Public top sellers
app.get("/sellers/top", async (req, res) => {
  try {
    const limit = Math.min(10, parseInt(req.query.limit, 10) || 3);
    const sellers = await req.db.collection("user")
      .aggregate([
        { $match: { role: "seller" } },
        {
          $lookup: {
            from: "products",
            localField: "email",
            foreignField: "sellerEmail",
            as: "products",
          },
        },
        {
          $project: {
            name: 1,
            email: 1,
            image: 1,
            location: 1,
            productCount: { $size: "$products" },
          },
        },
        { $sort: { productCount: -1 } },
        { $limit: limit },
      ])
      .toArray();
    res.status(200).json({ success: true, result: sellers });
  } catch (e) {
    sendError(res, 500, "Failed to fetch top sellers", e);
  }
});

// ✅ NEW: Public reviews
app.get("/reviews", async (req, res) => {
  try {
    const limit = Math.min(50, parseInt(req.query.limit, 10) || 6);
    const reviews = await req.db.collection("reviews")
      .find({})
      .sort({ createdAt: -1 })
      .limit(limit)
      .toArray();
    res.status(200).json({ success: true, result: reviews });
  } catch (e) {
    sendError(res, 500, "Failed to fetch reviews", e);
  }
});

app.get("/reviews/:productId", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.productId)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }
    const reviews = await req.db.collection("reviews")
      .find({ productId: req.params.productId })
      .sort({ createdAt: -1 })
      .toArray();
    res.status(200).json({ success: true, result: reviews });
  } catch (e) {
    sendError(res, 500, "Failed to fetch reviews", e);
  }
});

app.post("/reviews", verifyToken, buyerGuard, async (req, res) => {
  try {
    const { productId, rating, comment } = req.body;
    if (!productId || !rating) {
      return res.status(400).json({ success: false, message: "productId and rating are required" });
    }
    if (!isValidObjectId(productId)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }

    const reviewsCol = req.db.collection("reviews");
    const existing = await reviewsCol.findOne({ productId, buyerEmail: req.user.email });
    if (existing) {
      return res.status(409).json({ success: false, message: "You have already reviewed this product" });
    }

    const review = {
      productId,
      buyerEmail: req.user.email,
      buyerName: req.dbUser?.name || "",
      rating: Math.min(5, Math.max(1, Number(rating))),
      comment: comment || "",
      createdAt: new Date(),
    };

    const result = await reviewsCol.insertOne(review);
    res.status(201).json({ success: true, message: "Review added", result });
  } catch (e) {
    sendError(res, 500, "Failed to add review", e);
  }
});

// --- PRODUCTS ---
app.get("/products", async (req, res) => {
  try {
    const productsCol = req.db.collection("products");
    const { sort, order, search, category, status, condition } = req.query;
    const { page, limit, skip } = parsePagination(req.query);

    const filter = {};
    if (search) filter.title = { $regex: search, $options: "i" };
    if (category) filter.category = category;
    if (status) filter.status = status;
    if (condition) filter.condition = condition;

    const sortObj = {};
    if (sort) {
      const direction = order === "desc" ? -1 : 1;
      if (sort === "price") sortObj.price = direction;
      if (sort === "dateUploaded") sortObj.dateUploaded = direction;
    }

    const [result, total] = await Promise.all([
      productsCol.find(filter).sort(sortObj).skip(skip).limit(limit).toArray(),
      productsCol.countDocuments(filter),
    ]);

    res.status(200).json({
      success: true,
      message: "Products loaded successfully",
      result,
      total,
      page,
      limit,
    });
  } catch (e) {
    sendError(res, 500, "Failed to load products", e);
  }
});

app.get("/products/:id", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }
    const result = await req.db.collection("products").findOne({ _id: new ObjectId(req.params.id) });

    if (!result) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }
    res.status(200).json({ success: true, message: "Product info loaded", result });
  } catch (e) {
    sendError(res, 500, "Failed to load product", e);
  }
});

// ==========================================
// ADMIN PROTECTED ROUTES
// ==========================================

app.use("/admin", verifyToken, adminGuard);

// --- USERS ---
app.get("/admin/users", async (req, res) => {
  try {
    const usersCol = req.db.collection("user");
    const { search, role, sort, order, status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = {};
    if (search) {
      filter.$or = [
        { name: { $regex: search, $options: "i" } },
        { email: { $regex: search, $options: "i" } },
      ];
    }
    if (role) filter.role = role;
    if (status) filter.status = status;

    const sortObj = {};
    if (sort) sortObj[sort] = order === "desc" ? -1 : 1;
    else sortObj.createdAt = -1;

    const [result, total] = await Promise.all([
      usersCol.find(filter).sort(sortObj).skip(skip).limit(limit).toArray(),
      usersCol.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    sendError(res, 500, "Failed to fetch users", e);
  }
});

app.patch("/admin/users/:userId/status", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.userId)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, message: "Status is required" });
    }

    const result = await req.db.collection("user").updateOne(
      { _id: new ObjectId(req.params.userId) },
      { $set: { status } },
    );
    res.status(200).json({ success: true, message: "User status updated", result });
  } catch (e) {
    sendError(res, 500, "Failed to update user status", e);
  }
});

app.patch("/admin/users/:userId", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.userId)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }
    const { name, role, location, contact } = req.body;
    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (role !== undefined) update.role = role;
    if (location !== undefined) update.location = location;
    if (contact !== undefined) update.contact = contact;

    const result = await req.db.collection("user").updateOne(
      { _id: new ObjectId(req.params.userId) },
      { $set: update },
    );
    res.status(200).json({ success: true, message: "User updated", result });
  } catch (e) {
    sendError(res, 500, "Failed to update user", e);
  }
});

app.delete("/admin/users/:userId", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.userId)) {
      return res.status(400).json({ success: false, message: "Invalid user ID" });
    }
    await req.db.collection("user").deleteOne({ _id: new ObjectId(req.params.userId) });
    res.status(200).json({ success: true, message: "User deleted", result: null });
  } catch (e) {
    sendError(res, 500, "Failed to delete user", e);
  }
});

// --- PRODUCTS ---
app.get("/admin/products", async (req, res) => {
  try {
    const productsCol = req.db.collection("products");
    const { search, category, status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = {};
    if (search) filter.title = { $regex: search, $options: "i" };
    if (category) filter.category = category;
    if (status) filter.status = status;

    const [result, total] = await Promise.all([
      productsCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray(),
      productsCol.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    sendError(res, 500, "Failed to fetch products", e);
  }
});

app.patch("/admin/products/:productId", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.productId)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }
    const { title, category, condition, price, description } = req.body;
    const update = { updatedAt: new Date() };
    if (title !== undefined) update.title = title;
    if (category !== undefined) update.category = category;
    if (condition !== undefined) update.condition = condition;
    if (price !== undefined) update.price = Number(price);
    if (description !== undefined) update.description = description;

    const result = await req.db.collection("products").updateOne(
      { _id: new ObjectId(req.params.productId) },
      { $set: update },
    );
    res.status(200).json({ success: true, message: "Product updated", result });
  } catch (e) {
    sendError(res, 500, "Failed to update product", e);
  }
});

app.patch("/admin/products/:productId/status", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.productId)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }
    const { status } = req.body;
    const result = await req.db.collection("products").updateOne(
      { _id: new ObjectId(req.params.productId) },
      { $set: { status } },
    );
    res.status(200).json({ success: true, message: "Product status updated", result });
  } catch (e) {
    sendError(res, 500, "Failed to update product status", e);
  }
});

app.delete("/admin/products/:productId", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.productId)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }
    await req.db.collection("products").deleteOne({ _id: new ObjectId(req.params.productId) });
    res.status(200).json({ success: true, message: "Product deleted", result: null });
  } catch (e) {
    sendError(res, 500, "Failed to delete product", e);
  }
});

// --- ORDERS ---
app.get("/admin/orders", async (req, res) => {
  try {
    const ordersCol = req.db.collection("orders");
    const { search, status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = {};
    if (status) filter.orderStatus = status;
    if (search) {
      filter.$or = [
        { "buyerInfo.name": { $regex: search, $options: "i" } },
        { "buyerInfo.email": { $regex: search, $options: "i" } },
      ];
    }

    const [result, total] = await Promise.all([
      ordersCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray(),
      ordersCol.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    sendError(res, 500, "Failed to fetch orders", e);
  }
});

app.patch("/admin/orders/:orderId/status", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.orderId)) {
      return res.status(400).json({ success: false, message: "Invalid order ID" });
    }
    const { status } = req.body;
    const result = await req.db.collection("orders").updateOne(
      { _id: new ObjectId(req.params.orderId) },
      { $set: { orderStatus: status } },
    );
    res.status(200).json({ success: true, message: "Order status updated", result });
  } catch (e) {
    sendError(res, 500, "Failed to update order status", e);
  }
});

// ✅ NEW: Admin payments route
app.get("/admin/payments", async (req, res) => {
  try {
    const paymentsCol = req.db.collection("payments");
    const { search, status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = {};
    if (status) filter.paymentStatus = status;
    if (search) {
      filter.$or = [
        { buyerEmail: { $regex: search, $options: "i" } },
        { sellerEmail: { $regex: search, $options: "i" } },
        { transactionId: { $regex: search, $options: "i" } },
      ];
    }

    const [result, total] = await Promise.all([
      paymentsCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray(),
      paymentsCol.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    sendError(res, 500, "Failed to fetch payments", e);
  }
});

// --- ANALYTICS ---
app.get("/admin/analytics", async (req, res) => {
  try {
    const ordersCol = req.db.collection("orders");
    const productsCol = req.db.collection("products");
    const usersCol = req.db.collection("user");
    const paymentsCol = req.db.collection("payments");

    const [monthlyOrders, categoryPerformance, userGrowth, revenueByMonth] = await Promise.all([
      ordersCol.aggregate([
        { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      productsCol.aggregate([
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ]).toArray(),
      usersCol.aggregate([
        { $group: { _id: "$role", count: { $sum: 1 } } },
      ]).toArray(),
      paymentsCol.aggregate([
        { $match: { paymentStatus: "success" } },
        { $group: { _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } }, revenue: { $sum: "$amount" } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
    ]);

    res.status(200).json({
      success: true,
      result: {
        monthlyOrders: monthlyOrders.map((m) => ({ month: m._id, count: m.count })),
        categoryPerformance: categoryPerformance.map((c) => ({ category: c._id, count: c.count })),
        userGrowth: userGrowth.map((u) => ({ role: u._id, count: u.count })),
        revenueByMonth: revenueByMonth.map((r) => ({ month: r._id, revenue: r.revenue })),
      },
    });
  } catch (e) {
    // ✅ Fix: Don't leak error details in production
    sendError(res, 500, "Failed to load analytics", e);
  }
});

// --- STATS ---
app.get("/admin/stats/users", async (req, res) => {
  try {
    const total = await req.db.collection("user").countDocuments();
    res.status(200).json({ success: true, result: { total } });
  } catch (e) {
    sendError(res, 500, "Failed to fetch stats", e);
  }
});

app.get("/admin/stats/products", async (req, res) => {
  try {
    const total = await req.db.collection("products").countDocuments();
    res.status(200).json({ success: true, result: { total } });
  } catch (e) {
    sendError(res, 500, "Failed to fetch stats", e);
  }
});

app.get("/admin/stats/orders", async (req, res) => {
  try {
    const total = await req.db.collection("orders").countDocuments();
    res.status(200).json({ success: true, result: { total } });
  } catch (e) {
    sendError(res, 500, "Failed to fetch stats", e);
  }
});

app.get("/admin/stats/revenue", async (req, res) => {
  try {
    const data = await req.db.collection("payments").aggregate([
      { $match: { paymentStatus: "success" } },
      { $group: { _id: null, totalRevenue: { $sum: "$amount" } } },
    ]).toArray();
    const totalRevenue = data.length > 0 ? data[0].totalRevenue : 0;
    res.status(200).json({ success: true, result: { totalRevenue } });
  } catch (e) {
    sendError(res, 500, "Failed to fetch stats", e);
  }
});

app.get("/admin/stats/revenue-by-month", async (req, res) => {
  try {
    const revenueData = await req.db.collection("payments").aggregate([
      { $match: { paymentStatus: "success" } },
      { $group: { _id: { $month: "$createdAt" }, revenue: { $sum: "$amount" } } },
    ]).toArray();
    res.status(200).json({ success: true, result: { revenueByMonth: revenueData } });
  } catch (e) {
    sendError(res, 500, "Failed to fetch stats", e);
  }
});

app.get("/admin/analytics/summary", async (req, res) => {
  try {
    const [totalOrders, totalProducts, totalUsers, revenueData] = await Promise.all([
      req.db.collection("orders").countDocuments(),
      req.db.collection("products").countDocuments(),
      req.db.collection("user").countDocuments(),
      req.db.collection("payments").aggregate([
        { $match: { paymentStatus: "success" } },
        { $group: { _id: null, totalRevenue: { $sum: "$amount" } } },
      ]).toArray(),
    ]);

    const totalRevenue = revenueData.length > 0 ? revenueData[0].totalRevenue : 0;

    res.status(200).json({
      success: true,
      result: { totalOrders, totalProducts, totalUsers, totalRevenue },
    });
  } catch (e) {
    sendError(res, 500, "Failed to load analytics summary", e);
  }
});

// ==========================================
// SELLER PROTECTED ROUTES
// ==========================================

app.use("/seller", verifyToken, sellerGuard);

app.get("/seller/products", async (req, res) => {
  try {
    const productsCol = req.db.collection("products");
    const { search, category, status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = { sellerEmail: req.user.email };
    if (search) filter.title = { $regex: search, $options: "i" };
    if (category) filter.category = category;
    if (status) filter.status = status;

    const [result, total] = await Promise.all([
      productsCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray(),
      productsCol.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    sendError(res, 500, "Failed to fetch seller products", e);
  }
});

app.post("/seller/products", async (req, res) => {
  try {
    const product = {
      ...req.body,
      sellerEmail: req.user.email,
      sellerName: req.dbUser?.name || "",
      status: "available",
      dateUploaded: new Date(),
      createdAt: new Date(),
    };
    const result = await req.db.collection("products").insertOne(product);
    res.status(201).json({ success: true, message: "Product created", result });
  } catch (e) {
    sendError(res, 500, "Failed to create product", e);
  }
});

app.patch("/seller/products/:id", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }
    const filter = { _id: new ObjectId(req.params.id), sellerEmail: req.user.email };
    const result = await req.db.collection("products").updateOne(
      filter,
      { $set: { ...req.body, updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Product not found or not yours" });
    }
    res.status(200).json({ success: true, message: "Product updated", result });
  } catch (e) {
    sendError(res, 500, "Failed to update product", e);
  }
});

app.delete("/seller/products/:id", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }
    const filter = { _id: new ObjectId(req.params.id), sellerEmail: req.user.email };
    const result = await req.db.collection("products").deleteOne(filter);
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Product not found or not yours" });
    }
    res.status(200).json({ success: true, message: "Product deleted", result: null });
  } catch (e) {
    sendError(res, 500, "Failed to delete product", e);
  }
});

app.get("/seller/orders", async (req, res) => {
  try {
    const ordersCol = req.db.collection("orders");
    const { search, status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = { sellerEmail: req.user.email };
    if (status) filter.orderStatus = status;
    if (search) {
      filter.$or = [
        { "buyerInfo.name": { $regex: search, $options: "i" } },
        { "buyerInfo.email": { $regex: search, $options: "i" } },
      ];
    }

    const [result, total] = await Promise.all([
      ordersCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray(),
      ordersCol.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    sendError(res, 500, "Failed to fetch seller orders", e);
  }
});

app.patch("/seller/orders/:id/status", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid order ID" });
    }
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, message: "Status is required" });
    }
    const filter = { _id: new ObjectId(req.params.id), sellerEmail: req.user.email };
    const result = await req.db.collection("orders").updateOne(
      filter,
      { $set: { orderStatus: status, updatedAt: new Date() } },
    );
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Order not found or not yours" });
    }
    res.status(200).json({ success: true, message: "Order status updated", result });
  } catch (e) {
    sendError(res, 500, "Failed to update order status", e);
  }
});

app.get("/seller/stats", async (req, res) => {
  try {
    const [totalProducts, totalOrders, pendingOrders, revenueData] = await Promise.all([
      req.db.collection("products").countDocuments({ sellerEmail: req.user.email }),
      req.db.collection("orders").countDocuments({ sellerEmail: req.user.email }),
      req.db.collection("orders").countDocuments({ sellerEmail: req.user.email, orderStatus: "pending" }),
      req.db.collection("payments").aggregate([
        { $match: { sellerEmail: req.user.email, paymentStatus: "success" } },
        { $group: { _id: null, totalRevenue: { $sum: "$amount" } } },
      ]).toArray(),
    ]);
    const totalRevenue = revenueData.length > 0 ? revenueData[0].totalRevenue : 0;

    res.status(200).json({
      success: true,
      result: { totalProducts, totalOrders, totalRevenue, pendingOrders },
    });
  } catch (e) {
    sendError(res, 500, "Failed to fetch seller stats", e);
  }
});

app.get("/seller/analytics", async (req, res) => {
  try {
    const [monthlySales, topProducts] = await Promise.all([
      req.db.collection("orders").aggregate([
        { $match: { sellerEmail: req.user.email } },
        { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, count: { $sum: 1 } } },
        { $sort: { _id: 1 } },
      ]).toArray(),
      req.db.collection("products")
        .find({ sellerEmail: req.user.email })
        .sort({ soldCount: -1 })
        .limit(5)
        .toArray(),
    ]);

    res.status(200).json({
      success: true,
      result: {
        monthlySales: monthlySales.map((m) => ({ month: m._id, count: m.count })),
        topProducts,
      },
    });
  } catch (e) {
    sendError(res, 500, "Failed to fetch seller analytics", e);
  }
});

// ==========================================
// BUYER PROTECTED ROUTES
// ==========================================

app.use("/buyer", verifyToken, buyerGuard);

app.get("/buyer/orders", async (req, res) => {
  try {
    const ordersCol = req.db.collection("orders");
    const { status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = { "buyerInfo.email": req.user.email };
    if (status) filter.orderStatus = status;

    const [result, total] = await Promise.all([
      ordersCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray(),
      ordersCol.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    sendError(res, 500, "Failed to fetch buyer orders", e);
  }
});

app.patch("/buyer/orders/:id/cancel", async (req, res) => {
  try {
    if (!isValidObjectId(req.params.id)) {
      return res.status(400).json({ success: false, message: "Invalid order ID" });
    }
    const filter = {
      _id: new ObjectId(req.params.id),
      "buyerInfo.email": req.user.email,
      orderStatus: "pending",
    };
    const result = await req.db.collection("orders").updateOne(filter, {
      $set: { orderStatus: "cancelled", updatedAt: new Date() },
    });
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Order not found or cannot be cancelled" });
    }
    res.status(200).json({ success: true, message: "Order cancelled", result });
  } catch (e) {
    sendError(res, 500, "Failed to cancel order", e);
  }
});

app.get("/buyer/stats", async (req, res) => {
  try {
    const [totalOrders, user, recentPurchases] = await Promise.all([
      req.db.collection("orders").countDocuments({ "buyerInfo.email": req.user.email }),
      req.db.collection("user").findOne({ email: req.user.email }),
      req.db.collection("orders")
        .find({ "buyerInfo.email": req.user.email, orderStatus: "delivered" })
        .sort({ _id: -1 })
        .limit(5)
        .toArray(),
    ]);

    const wishlistCount = user?.wishlist?.length || 0;

    res.status(200).json({
      success: true,
      result: { totalOrders, wishlistCount, recentPurchases },
    });
  } catch (e) {
    sendError(res, 500, "Failed to fetch buyer stats", e);
  }
});

// ==========================================
// WISHLIST ROUTES
// ==========================================

app.get("/wishlist", verifyToken, async (req, res) => {
  try {
    const user = await req.db.collection("user").findOne({ email: req.user.email });
    const wishlist = user?.wishlist || [];

    if (wishlist.length === 0) {
      return res.status(200).json({ success: true, result: [] });
    }

    const validIds = wishlist.filter(id => isValidObjectId(id));
    const objectIds = validIds.map((id) => new ObjectId(id));
    const result = await req.db.collection("products").find({ _id: { $in: objectIds } }).toArray();

    res.status(200).json({ success: true, result });
  } catch (e) {
    sendError(res, 500, "Failed to fetch wishlist", e);
  }
});

app.post("/wishlist/:productId", verifyToken, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.productId)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }
    await req.db.collection("user").updateOne(
      { email: req.user.email },
      { $addToSet: { wishlist: req.params.productId } },
    );
    res.status(200).json({ success: true, message: "Added to wishlist", result: null });
  } catch (e) {
    sendError(res, 500, "Failed to update wishlist", e);
  }
});

app.delete("/wishlist/:productId", verifyToken, async (req, res) => {
  try {
    if (!isValidObjectId(req.params.productId)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }
    await req.db.collection("user").updateOne(
      { email: req.user.email },
      { $pull: { wishlist: req.params.productId } },
    );
    res.status(200).json({ success: true, message: "Removed from wishlist", result: null });
  } catch (e) {
    sendError(res, 500, "Failed to update wishlist", e);
  }
});

// ==========================================
// PROFILE ROUTES
// ==========================================

app.get("/profile", verifyToken, async (req, res) => {
  try {
    const user = await req.db.collection("user").findOne({ email: req.user.email });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const { password, ...profile } = user;
    res.status(200).json({ success: true, result: profile });
  } catch (e) {
    sendError(res, 500, "Failed to fetch profile", e);
  }
});

app.patch("/profile", verifyToken, async (req, res) => {
  try {
    const { name, contact, location, image } = req.body;
    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (contact !== undefined) update.contact = contact;
    if (location !== undefined) update.location = location;
    if (image !== undefined) update.image = image;

    const result = await req.db.collection("user").updateOne(
      { email: req.user.email },
      { $set: update },
    );
    res.status(200).json({ success: true, message: "Profile updated", result });
  } catch (e) {
    sendError(res, 500, "Failed to update profile", e);
  }
});

// ==========================================
// PAYMENTS ROUTES
// ==========================================

app.post("/payments/create-intent", verifyToken, buyerGuard, async (req, res) => {
  try {
    const { amount, productId, productTitle } = req.body;

    if (!amount || !productId) {
      return res.status(400).json({ success: false, message: "amount and productId are required" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100),
      currency: "bdt",
      metadata: { productId, productTitle, buyerEmail: req.user.email },
    });

    res.status(200).json({
      success: true,
      result: { clientSecret: paymentIntent.client_secret },
    });
  } catch (e) {
    sendError(res, 500, "Failed to create payment intent", e);
  }
});

app.post("/payments/confirm", verifyToken, buyerGuard, async (req, res) => {
  try {
    const { transactionId, productId, sellerEmail, amount, productTitle } = req.body;

    if (!transactionId || !productId) {
      return res.status(400).json({ success: false, message: "transactionId and productId are required" });
    }

    if (!isValidObjectId(productId)) {
      return res.status(400).json({ success: false, message: "Invalid product ID" });
    }

    const paymentIntent = await stripe.paymentIntents.retrieve(transactionId);
    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({ success: false, message: "Payment not confirmed by Stripe" });
    }

    const buyer = req.dbUser;
    const productsCol = req.db.collection("products");
    const ordersCol = req.db.collection("orders");
    const paymentsCol = req.db.collection("payments");

    const existing = await paymentsCol.findOne({ transactionId });
    if (existing) {
      return res.status(409).json({ success: false, message: "Payment already recorded" });
    }

    const product = await productsCol.findOne({ _id: new ObjectId(productId) });
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const now = new Date();

    const order = {
      buyerInfo: { userId: buyer._id.toString(), name: buyer.name, email: buyer.email },
      sellerInfo: { email: product.sellerEmail, name: product.sellerName },
      sellerEmail: product.sellerEmail,
      productId,
      productTitle: product.title,
      totalAmount: amount,
      orderStatus: "pending",
      paymentStatus: "paid",
      createdAt: now,
      updatedAt: now,
    };
    const orderResult = await ordersCol.insertOne(order);

    await paymentsCol.insertOne({
      transactionId,
      orderId: orderResult.insertedId.toString(),
      productId,
      buyerEmail: buyer.email,
      sellerEmail: product.sellerEmail,
      amount,
      paymentStatus: "success",
      paymentMethod: "stripe",
      createdAt: now,
    });

    await productsCol.updateOne(
      { _id: new ObjectId(productId) },
      { $set: { status: "sold", updatedAt: now } },
    );

    res.status(201).json({
      success: true,
      message: "Order and payment saved",
      result: { orderId: orderResult.insertedId },
    });
  } catch (e) {
    sendError(res, 500, "Failed to save payment", e);
  }
});

app.get("/payments/my-history", verifyToken, buyerGuard, async (req, res) => {
  try {
    const paymentsCol = req.db.collection("payments");
    const { status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = { buyerEmail: req.user.email };
    if (status) filter.paymentStatus = status;

    const [result, total] = await Promise.all([
      paymentsCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray(),
      paymentsCol.countDocuments(filter),
    ]);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    sendError(res, 500, "Failed to fetch payment history", e);
  }
});

// ==========================================
// UPLOAD ROUTES
// ==========================================

app.post("/upload", verifyToken, async (req, res) => {
  try {
    const mimeType = req.headers["content-type"] || "image/jpeg";
    const folder = req.headers["x-upload-folder"] || "Kino.com";
    const fileName = req.headers["x-upload-filename"] || "upload";

    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    if (!buffer.length) {
      return res.status(400).json({ success: false, message: "No file data received" });
    }

    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const uploadsCol = req.db.collection("cloudinary_uploads");

    const existing = await uploadsCol.findOne({ hash });
    if (existing) {
      return res.status(200).json({
        success: true,
        result: { url: existing.url, public_id: existing.public_id, isDuplicate: true },
      });
    }

    const dataUri = `data:${mimeType};base64,${buffer.toString("base64")}`;
    const result = await cloudinary.uploader.upload(dataUri, {
      folder,
      resource_type: "image",
      transformation: [
        { width: 1200, height: 900, crop: "limit" },
        { quality: "auto" },
        { fetch_format: "auto" },
      ],
    });

    try {
      await uploadsCol.insertOne({
        hash,
        fileName,
        fileSize: buffer.length,
        mimeType,
        public_id: result.public_id,
        url: result.secure_url,
        folder: result.folder,
        uploadedBy: req.user.email,
        createdAt: new Date(),
      });
    } catch (e) {
      if (e.code === 11000) {
        const winner = await uploadsCol.findOne({ hash });
        return res.status(200).json({
          success: true,
          result: { url: winner.url, public_id: winner.public_id, isDuplicate: true },
        });
      }
      throw e;
    }

    return res.status(200).json({
      success: true,
      result: { url: result.secure_url, public_id: result.public_id, isDuplicate: false },
    });
  } catch (e) {
    sendError(res, 500, "Upload failed", e);
  }
});

app.delete("/upload/*publicId", verifyToken, async (req, res) => {
  try {
    const publicId = req.params.publicId;
    const uploadsCol = req.db.collection("cloudinary_uploads");

    const record = await uploadsCol.findOne({ public_id: publicId });
    if (!record) {
      return res.status(404).json({ success: false, message: "Image not found" });
    }
    if (record.uploadedBy !== req.user.email) {
      return res.status(403).json({ success: false, message: "Forbidden" });
    }

    await cloudinary.uploader.destroy(publicId);
    await uploadsCol.deleteOne({ public_id: publicId });

    return res.status(200).json({ success: true, message: "Image deleted" });
  } catch (e) {
    sendError(res, 500, "Delete failed", e);
  }
});

// ==========================================
// SERVER INITIALIZATION
// ==========================================

if (process.env.NODE_ENV !== "production") {
  app.listen(port, async () => {
    await connectToDB();
    console.log(`Server is running at port:${port}`);
  });
}

export default app;

/*
Vercel initiates a serverless container. This containers code reading flow goes one way, doesn't wait for a nested awaited route definition or nested await functions inside the body of `run` function to return a result, and as soon as the code is read to the end, the undiscovered result remains null. The code reading finishes and the container shuts down completely. For example: when I'm requesting the "/doctors" url, the run function is busy connecting to the server instance to mongodb. So the request hits the wall, and all the routes remain unregistered, with an unsuccessful 404 code. As soon as the awaited connection is established, the one way code reading flow dashes through all those 404s and reach to the end of code. The containers job is to return with HTTP responses and as much data it can gather meanwhile. Well, because of seeing 404s on every endpoint, the return appears to the end user empty handed.

So all the route definition codes inside the `run` function has to come to the root/module level.
No need to confuse the route endpoints with any other asynchronous functions btw.

# The Timeline
0ms: Vercel starts reading your index.js.
5ms: Express app is created. run() starts. It hits await client.connect(). Execution yields. Vercel reaches the end of the file and exports the app (which currently has zero routes).
50ms: A user requests /doctors.
51ms: Express checks its registry. No routes found. Express immediately sends the HTTP response: 404 Cannot GET /doctors back to the user.
52ms: Vercel sees the HTTP response was sent. The user's browser displays the error. That specific request is permanently closed.
...
500ms: MongoDB finally connects. The run() function resumes and registers the routes.

What happens to the request? It's already dead. It got its 404 450 milliseconds ago. The code doesn't "dash through" the 404; the 404 was a message sent to the client, and the connection was closed.

However...
If the user refreshes their browser after the 500ms mark, the second request will hit the server. By now, run() has finished, the routes are registered, and the request will succeed.

But in a serverless environment, Vercel often spins down the container after that first 404 because it thinks the job is done. So the container dies before run() ever finishes.

*/
