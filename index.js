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
      process.env.CLIENT_URL, // your Vercel URL when deployed
    ].filter(Boolean),
    credentials: true, // needed if you send cookies/JWT later
  }),
);
app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

let cacheDB = null;

const connectToDB = async () => {
  if (cacheDB) return cacheDB;

  try {
    // Connect the client to the server	(optional starting in v4.7)
    await client.connect();

    cacheDB = await client.db("kino_main");
    return cacheDB;
  } catch (e) {
    console.log("Error connecting to MongoDB", e);
  }
};

// Make DB available in all routes easily
app.use(async (req, res, next) => {
  req.db = await connectToDB();
  next();
});

// ==========================================
// MIDDLEWARE
// ==========================================

const verifyToken = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      return res
        .status(401)
        .json({ success: false, message: "Unauthorized entry" });
    }
    const token = authHeader.split(" ")[1];
    try {
      const { payload } = await jwtVerify(token, JWKS);
      req.user = payload;
      console.log("JWT authenticated:", req.user);
      next();
    } catch (e) {
      return res
        .status(403)
        .json({ success: false, message: "Invalid or expired token" });
    }
  } catch (e) {
    return res
      .status(401)
      .json({ success: false, message: "Authentication error" });
  }
};

const adminGuard = async (req, res, next) => {
  try {
    if (!req.user || !req.user.email) {
      return res
        .status(401)
        .json({ success: false, message: "Not authenticated" });
    }
    const usersCol = req.db.collection("user");
    const user = await usersCol.findOne({
      email: req.user.email,
      role: "admin",
    });
    if (!user || user.role.toLowerCase() !== "admin") {
      return res
        .status(403)
        .json({ success: false, message: "Forbidden: Admins only" });
    }
    req.dbUser = user;
    next();
  } catch (error) {
    res
      .status(500)
      .json({ success: false, message: "Authorization check failed" });
  }
};

// Sellers AND admins are allowed
const sellerGuard = async (req, res, next) => {
  try {
    if (!req.user || !req.user.email) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    const usersCol = req.db.collection("user");
    const user = await usersCol.findOne({ email: req.user.email });
    if (!user || !["seller", "admin"].includes(user.role?.toLowerCase())) {
      return res.status(403).json({ success: false, message: "Forbidden: Sellers and Admins only" });
    }
    req.dbUser = user;
    next();
  } catch (error) {
    res.status(500).json({ success: false, message: "Authorization check failed" });
  }
};

// Buyers AND admins are allowed
const buyerGuard = async (req, res, next) => {
  try {
    if (!req.user || !req.user.email) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    const usersCol = req.db.collection("user");
    const user = await usersCol.findOne({ email: req.user.email });
    if (!user || !["buyer", "admin"].includes(user.role?.toLowerCase())) {
      return res.status(403).json({ success: false, message: "Forbidden: Buyers and Admins only" });
    }
    req.dbUser = user;
    next();
  } catch (error) {
    res.status(500).json({ success: false, message: "Authorization check failed" });
  }
};

const parsePagination = (query) => {
  const page = parseInt(query.page, 10) || 1;
  const limit = parseInt(query.limit, 10) || 10;
  return { page, limit, skip: (page - 1) * limit };
};

// ==========================================
// PUBLIC ROUTES
// ==========================================

app.get("/", (req, res) => {
  res.json({ message: "Kino.com server has started" });
});

app.get("/products", async (req, res) => {
  try {
    const productsCol = req.db.collection("products");
    const { sort, order, search, category, status, condition } = req.query;
    const { page, limit, skip } = parsePagination(req.query); // use parsePagination

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

    const result = await productsCol
      .find(filter)
      .sort(sortObj)
      .skip(skip)          // ← was missing
      .limit(limit)
      .toArray();

    const total = await productsCol.countDocuments(filter); // ← was missing

    res.status(200).json({
      success: true,
      message: "Products loaded successfully",
      result,
      total,               // ← needed for pagination controls
      page,
      limit,
    });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to load products" });
  }
});;

app.get("/products/:id", async (req, res) => {
  try {
    const productsCol = req.db.collection("products");
    const { id } = req.params;
    // Fixed: Searching by _id ObjectId instead of string id
    const result = await productsCol.findOne({ _id: new ObjectId(id) });

    if (!result)
      return res
        .status(404)
        .json({ success: false, message: "Product not found" });
    res
      .status(200)
      .json({ success: true, message: "Product info loaded", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to load product" });
  }
});

// ==========================================
// ADMIN PROTECTED ROUTES
// ==========================================

// All /admin routes require valid token AND admin role
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

    const result = await usersCol
      .find(filter)
      .sort(sortObj)
      .skip(skip)
      .limit(limit)
      .toArray();
    const total = await usersCol.countDocuments(filter);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch users" });
  }
});

app.patch("/admin/users/:userId/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!status)
      return res
        .status(400)
        .json({ success: false, message: "Status is required" });

    const result = await req.db
      .collection("user")
      .updateOne(
        { _id: new ObjectId(req.params.userId) },
        { $set: { status } },
      );
    res
      .status(200)
      .json({ success: true, message: "User status updated", result });
  } catch (e) {
    res
      .status(500)
      .json({ success: false, message: "Failed to update user status" });
  }
});

app.patch("/admin/users/:userId", async (req, res) => {
  try {
    const { name, role, location, contact } = req.body;
    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (role !== undefined) update.role = role;
    if (location !== undefined) update.location = location;
    if (contact !== undefined) update.contact = contact;

    const result = await req.db
      .collection("user")
      .updateOne({ _id: new ObjectId(req.params.userId) }, { $set: update });
    res.status(200).json({ success: true, message: "User updated", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to update user" });
  }
});

app.delete("/admin/users/:userId", async (req, res) => {
  try {
    await req.db
      .collection("user")
      .deleteOne({ _id: new ObjectId(req.params.userId) });
    res
      .status(200)
      .json({ success: true, message: "User deleted", result: null });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to delete user" });
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

    const result = await productsCol
      .find(filter)
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    const total = await productsCol.countDocuments(filter);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    res
      .status(500)
      .json({ success: false, message: "Failed to fetch products" });
  }
});

app.patch("/admin/products/:productId", async (req, res) => {
  try {
    const { title, category, condition, price, description } = req.body;
    const update = { updatedAt: new Date() };
    if (title !== undefined) update.title = title;
    if (category !== undefined) update.category = category;
    if (condition !== undefined) update.condition = condition;
    if (price !== undefined) update.price = Number(price);
    if (description !== undefined) update.description = description;

    const result = await req.db
      .collection("products")
      .updateOne({ _id: new ObjectId(req.params.productId) }, { $set: update });
    res.status(200).json({ success: true, message: "Product updated", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to update product" });
  }
});

app.patch("/admin/products/:productId/status", async (req, res) => {
  try {
    const { status } = req.body;
    const result = await req.db
      .collection("products")
      .updateOne(
        { _id: new ObjectId(req.params.productId) },
        { $set: { status } },
      );
    res
      .status(200)
      .json({ success: true, message: "Product status updated", result });
  } catch (e) {
    res
      .status(500)
      .json({ success: false, message: "Failed to update product status" });
  }
});

app.delete("/admin/products/:productId", async (req, res) => {
  try {
    await req.db
      .collection("products")
      .deleteOne({ _id: new ObjectId(req.params.productId) });
    res
      .status(200)
      .json({ success: true, message: "Product deleted", result: null });
  } catch (e) {
    res
      .status(500)
      .json({ success: false, message: "Failed to delete product" });
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

    const result = await ordersCol
      .find(filter)
      .sort({ _id: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
    const total = await ordersCol.countDocuments(filter);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
});

app.patch("/admin/orders/:orderId/status", async (req, res) => {
  try {
    const { status } = req.body;
    const result = await req.db
      .collection("orders")
      .updateOne(
        { _id: new ObjectId(req.params.orderId) },
        { $set: { orderStatus: status } },
      );
    res
      .status(200)
      .json({ success: true, message: "Order status updated", result });
  } catch (e) {
    res
      .status(500)
      .json({ success: false, message: "Failed to update order status" });
  }
});

// --- ANALYTICS ---
app.get("/admin/analytics", async (req, res) => {
  try {
    const ordersCol = req.db.collection("orders");
    const productsCol = req.db.collection("products");
    const usersCol = req.db.collection("user");
    const paymentsCol = req.db.collection("payments");

    const monthlyOrders = await ordersCol
      .aggregate([
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
            count: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    const categoryPerformance = await productsCol
      .aggregate([
        { $group: { _id: "$category", count: { $sum: 1 } } },
        { $sort: { count: -1 } },
      ])
      .toArray();

    const userGrowth = await usersCol
      .aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }])
      .toArray();

    const revenueByMonth = await paymentsCol
      .aggregate([
        { $match: { paymentStatus: "success" } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt" } },
            revenue: { $sum: "$amount" },
          },
        },
        { $sort: { _id: 1 } },
      ])
      .toArray();

    res.status(200).json({
      success: true,
      result: {
        monthlyOrders: monthlyOrders.map((m) => ({
          month: m._id,
          count: m.count,
        })),
        categoryPerformance: categoryPerformance.map((c) => ({
          category: c._id,
          count: c.count,
        })),
        userGrowth: userGrowth.map((u) => ({ role: u._id, count: u.count })),
        revenueByMonth: revenueByMonth.map((r) => ({
          month: r._id,
          revenue: r.revenue,
        })),
      },
    });
  } catch (e) {
    console.error("Analytics error:", e);
    res
      .status(500)
      .json({ success: false, message: e.message, details: e.stack, cause: e.cause, name: e.name, code: e.code, info: e.info });
  }
});

// --- STATS ---
app.get("/admin/stats/users", async (req, res) => {
  try {
    const total = await req.db.collection("user").countDocuments();
    res.status(200).json({ success: true, result: { total } });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
});

app.get("/admin/stats/products", async (req, res) => {
  try {
    const total = await req.db.collection("products").countDocuments();
    res.status(200).json({ success: true, result: { total } });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
});

app.get("/admin/stats/orders", async (req, res) => {
  try {
    const total = await req.db.collection("orders").countDocuments();
    res.status(200).json({ success: true, result: { total } });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
});

app.get("/admin/stats/revenue", async (req, res) => {
  try {
    const totalRevenueData = await req.db
      .collection("payments")
      .aggregate([
        { $match: { paymentStatus: "success" } },
        { $group: { _id: null, totalRevenue: { $sum: "$amount" } } },
      ])
      .toArray();

    const totalRevenue =
      totalRevenueData.length > 0 ? totalRevenueData[0].totalRevenue : 0;
    res.status(200).json({ success: true, result: { totalRevenue } });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
});

app.get("/admin/stats/revenue-by-month", async (req, res) => {
  try {
    const revenueByMonth = await req.db.collection("payments");
    const revenueData = await revenueByMonth
      .aggregate([
        { $match: { paymentStatus: "success" } },
        {
          $group: {
            _id: { $month: "$createdAt" },
            revenue: { $sum: "$amount" },
          },
        },
      ])
      .toArray();

    res
      .status(200)
      .json({ success: true, result: { revenueByMonth: revenueData } });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch stats" });
  }
});

app.get("/admin/analytics/summary", async (req, res) => {
  try {
    const ordersCol = req.db.collection("orders");
    const productsCol = req.db.collection("products");
    const usersCol = req.db.collection("user");
    const paymentsCol = req.db.collection("payments");

    const totalOrders = await ordersCol.countDocuments();
    const totalProducts = await productsCol.countDocuments();
    const totalUsers = await usersCol.countDocuments();
    const totalRevenueData = await paymentsCol
      .aggregate([
        {
          $match: {
            paymentStatus: "success",
          },
        },
        {
          $group: {
            _id: null,
            totalRevenue: {
              $sum: "$amount",
            },
          },
        },
      ])
      .toArray();

    console.log("Total revenue data:", totalRevenueData); // Debugging line
    const totalRevenue =
      totalRevenueData.length > 0 ? totalRevenueData[0].totalRevenue : 0;

    res.status(200).json({
      success: true,
      result: {
        totalOrders,
        totalProducts,
        totalUsers,
        totalRevenue,
      },
    });
  } catch (e) {
    console.error("Analytics summary error:", e);
    res
      .status(500)
      .json({ success: false, message: "Failed to load analytics summary" });
  }
});

// ==========================================
// SELLER PROTECTED ROUTES  (seller | admin)
// ==========================================

app.use("/seller", verifyToken, sellerGuard);

// --- SELLER PRODUCTS ---

app.get("/seller/products", async (req, res) => {
  try {
    const productsCol = req.db.collection("products");
    const { search, category, status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = { sellerEmail: req.user.email };
    if (search) filter.title = { $regex: search, $options: "i" };
    if (category) filter.category = category;
    if (status) filter.status = status;

    const result = await productsCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray();
    const total = await productsCol.countDocuments(filter);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch seller products" });
  }
});

app.post("/seller/products", async (req, res) => {
  try {
    const productsCol = req.db.collection("products");
    const product = {
      ...req.body,
      sellerEmail: req.user.email,
      sellerName: req.dbUser.name || "",
      status: "available",
      dateUploaded: new Date(),
      createdAt: new Date(),
    };
    const result = await productsCol.insertOne(product);
    res.status(201).json({ success: true, message: "Product created", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to create product" });
  }
});

// Ownership check — seller can only update their own product
app.patch("/seller/products/:id", async (req, res) => {
  try {
    const productsCol = req.db.collection("products");
    const filter = { _id: new ObjectId(req.params.id), sellerEmail: req.user.email };
    const result = await productsCol.updateOne(filter, { $set: { ...req.body, updatedAt: new Date() } });
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Product not found or not yours" });
    }
    res.status(200).json({ success: true, message: "Product updated", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to update product" });
  }
});

// Ownership check — seller can only delete their own product
app.delete("/seller/products/:id", async (req, res) => {
  try {
    const productsCol = req.db.collection("products");
    const filter = { _id: new ObjectId(req.params.id), sellerEmail: req.user.email };
    const result = await productsCol.deleteOne(filter);
    if (result.deletedCount === 0) {
      return res.status(404).json({ success: false, message: "Product not found or not yours" });
    }
    res.status(200).json({ success: true, message: "Product deleted", result: null });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to delete product" });
  }
});

// --- SELLER ORDERS ---

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

    const result = await ordersCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray();
    const total = await ordersCol.countDocuments(filter);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch seller orders" });
  }
});

app.patch("/seller/orders/:id/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) {
      return res.status(400).json({ success: false, message: "Status is required" });
    }
    const ordersCol = req.db.collection("orders");
    const filter = { _id: new ObjectId(req.params.id), sellerEmail: req.user.email };
    const result = await ordersCol.updateOne(filter, { $set: { orderStatus: status, updatedAt: new Date() } });
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Order not found or not yours" });
    }
    res.status(200).json({ success: true, message: "Order status updated", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to update order status" });
  }
});

// --- SELLER STATS ---

app.get("/seller/stats", async (req, res) => {
  try {
    const productsCol = req.db.collection("products");
    const ordersCol = req.db.collection("orders");
    const paymentsCol = req.db.collection("payments");

    const totalProducts = await productsCol.countDocuments({ sellerEmail: req.user.email });
    const totalOrders = await ordersCol.countDocuments({ sellerEmail: req.user.email });
    const pendingOrders = await ordersCol.countDocuments({ sellerEmail: req.user.email, orderStatus: "pending" });

    const revenueData = await paymentsCol.aggregate([
      { $match: { sellerEmail: req.user.email, paymentStatus: "success" } },
      { $group: { _id: null, totalRevenue: { $sum: "$amount" } } },
    ]).toArray();
    const totalRevenue = revenueData.length > 0 ? revenueData[0].totalRevenue : 0;

    res.status(200).json({
      success: true,
      result: { totalProducts, totalOrders, totalRevenue, pendingOrders },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch seller stats" });
  }
});

// --- SELLER ANALYTICS ---

app.get("/seller/analytics", async (req, res) => {
  try {
    const ordersCol = req.db.collection("orders");
    const productsCol = req.db.collection("products");

    // Orders have no amount field — revenue comes from the payments collection.
    // Joining here via $lookup on orderId would require string-to-ObjectId coercion;
    // totalRevenue is already available via /seller/stats so we omit it here.
    const monthlySales = await ordersCol.aggregate([
      { $match: { sellerEmail: req.user.email } },
      {
        $group: {
          _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } },
          count: { $sum: 1 },
        },
      },
      { $sort: { _id: 1 } },
    ]).toArray();

    const topProducts = await productsCol
      .find({ sellerEmail: req.user.email })
      .sort({ soldCount: -1 })
      .limit(5)
      .toArray();

    res.status(200).json({
      success: true,
      result: {
        monthlySales: monthlySales.map((m) => ({ month: m._id, count: m.count })),
        topProducts,
      },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch seller analytics" });
  }
});

// ==========================================
// BUYER PROTECTED ROUTES  (buyer | admin)
// ==========================================

app.use("/buyer", verifyToken, buyerGuard);

// --- BUYER ORDERS ---

app.get("/buyer/orders", async (req, res) => {
  try {
    const ordersCol = req.db.collection("orders");
    const { status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = { "buyerInfo.email": req.user.email };
    if (status) filter.orderStatus = status;

    const result = await ordersCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray();
    const total = await ordersCol.countDocuments(filter);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch buyer orders" });
  }
});

// Only pending orders can be cancelled
app.patch("/buyer/orders/:id/cancel", async (req, res) => {
  try {
    const ordersCol = req.db.collection("orders");
    const filter = {
      _id: new ObjectId(req.params.id),
      "buyerInfo.email": req.user.email,
      orderStatus: "pending",
    };
    const result = await ordersCol.updateOne(filter, {
      $set: { orderStatus: "cancelled", updatedAt: new Date() },
    });
    if (result.matchedCount === 0) {
      return res.status(404).json({ success: false, message: "Order not found or cannot be cancelled" });
    }
    res.status(200).json({ success: true, message: "Order cancelled", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to cancel order" });
  }
});

// --- BUYER STATS ---

app.get("/buyer/stats", async (req, res) => {
  try {
    const ordersCol = req.db.collection("orders");
    const usersCol = req.db.collection("user");

    const totalOrders = await ordersCol.countDocuments({ "buyerInfo.email": req.user.email });

    const user = await usersCol.findOne({ email: req.user.email });
    const wishlistCount = user?.wishlist?.length || 0;

    const recentPurchases = await ordersCol
      .find({ "buyerInfo.email": req.user.email, orderStatus: "delivered" })
      .sort({ _id: -1 })
      .limit(5)
      .toArray();

    res.status(200).json({
      success: true,
      result: { totalOrders, wishlistCount, recentPurchases },
    });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch buyer stats" });
  }
});

// ==========================================
// WISHLIST ROUTES  (any authenticated user)
// ==========================================

app.get("/wishlist", verifyToken, async (req, res) => {
  try {
    const usersCol = req.db.collection("user");
    const productsCol = req.db.collection("products");

    const user = await usersCol.findOne({ email: req.user.email });
    const wishlist = user?.wishlist || [];

    if (wishlist.length === 0) {
      return res.status(200).json({ success: true, result: [] });
    }

    const objectIds = wishlist.map((id) => new ObjectId(id));
    const result = await productsCol.find({ _id: { $in: objectIds } }).toArray();

    res.status(200).json({ success: true, result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch wishlist" });
  }
});

app.post("/wishlist/:productId", verifyToken, async (req, res) => {
  try {
    const usersCol = req.db.collection("user");
    await usersCol.updateOne(
      { email: req.user.email },
      { $addToSet: { wishlist: req.params.productId } },
    );
    res.status(200).json({ success: true, message: "Added to wishlist", result: null });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to update wishlist" });
  }
});

app.delete("/wishlist/:productId", verifyToken, async (req, res) => {
  try {
    const usersCol = req.db.collection("user");
    await usersCol.updateOne(
      { email: req.user.email },
      { $pull: { wishlist: req.params.productId } },
    );
    res.status(200).json({ success: true, message: "Removed from wishlist", result: null });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to update wishlist" });
  }
});

// ==========================================
// PROFILE ROUTES  (any authenticated user)
// ==========================================

app.get("/profile", verifyToken, async (req, res) => {
  try {
    const usersCol = req.db.collection("user");
    const user = await usersCol.findOne({ email: req.user.email });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    const { password, ...profile } = user;
    res.status(200).json({ success: true, result: profile });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch profile" });
  }
});

app.patch("/profile", verifyToken, async (req, res) => {
  try {
    const usersCol = req.db.collection("user");
    const { name, contact, location, image } = req.body;
    const update = { updatedAt: new Date() };
    if (name !== undefined) update.name = name;
    if (contact !== undefined) update.contact = contact;
    if (location !== undefined) update.location = location;
    if (image !== undefined) update.image = image;

    const result = await usersCol.updateOne({ email: req.user.email }, { $set: update });
    res.status(200).json({ success: true, message: "Profile updated", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to update profile" });
  }
});

// ==========================================
// PAYMENTS ROUTES  (buyer | admin)
// ==========================================

app.post("/payments/create-intent", verifyToken, buyerGuard, async (req, res) => {
  try {
    const { amount, productId, productTitle } = req.body;

    if (!amount || !productId) {
      return res.status(400).json({ success: false, message: "amount and productId are required" });
    }

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(amount * 100), // Stripe expects amount in paisa/cents
      currency: "bdt",                  // change to "usd" if needed
      metadata: {
        productId,
        productTitle,
        buyerEmail: req.user.email,
      },
    });

    res.status(200).json({
      success: true,
      result: { clientSecret: paymentIntent.client_secret },
    });
  } catch (e) {
    console.error("Stripe create-intent error:", e);
    res.status(500).json({ success: false, message: "Failed to create payment intent" });
  }
});

// POST /payments/confirm
// Protected: buyer must be logged in
// Body: { transactionId, productId, sellerEmail, amount, productTitle }
app.post("/payments/confirm", verifyToken, buyerGuard, async (req, res) => {
  try {
    const { transactionId, productId, sellerEmail, amount, productTitle } = req.body;

    if (!transactionId || !productId) {
      return res.status(400).json({ success: false, message: "transactionId and productId are required" });
    }

    // Verify the payment intent actually succeeded with Stripe
    const paymentIntent = await stripe.paymentIntents.retrieve(transactionId);
    if (paymentIntent.status !== "succeeded") {
      return res.status(400).json({ success: false, message: "Payment not confirmed by Stripe" });
    }

    const buyer = req.dbUser;
    const productsCol = req.db.collection("products");
    const ordersCol = req.db.collection("orders");
    const paymentsCol = req.db.collection("payments");

    const product = await productsCol.findOne({ _id: new ObjectId(productId) });
    if (!product) {
      return res.status(404).json({ success: false, message: "Product not found" });
    }

    const now = new Date();

    // 1. Create the order
    const order = {
      buyerInfo: {
        userId: buyer._id.toString(),
        name: buyer.name,
        email: buyer.email,
      },
      sellerInfo: {
        email: product.sellerEmail,
        name: product.sellerName,
      },
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

    // 2. Save payment record
    const payment = {
      transactionId,
      orderId: orderResult.insertedId.toString(),
      productId,
      buyerEmail: buyer.email,
      sellerEmail: product.sellerEmail,
      amount,
      paymentStatus: "success",
      paymentMethod: "stripe",
      createdAt: now,
    };
    await paymentsCol.insertOne(payment);

    // 3. Mark product as sold (optional — remove if you allow multiple sales)
    await productsCol.updateOne(
      { _id: new ObjectId(productId) },
      { $set: { status: "sold", updatedAt: now } }
    );

    res.status(201).json({
      success: true,
      message: "Order and payment saved",
      result: { orderId: orderResult.insertedId },
    });
  } catch (e) {
    console.error("Stripe confirm error:", e);
    res.status(500).json({ success: false, message: "Failed to save payment" });
  }
});

app.get("/payments/my-history", verifyToken, buyerGuard, async (req, res) => {
  try {
    const paymentsCol = req.db.collection("payments");
    const { status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = { buyerEmail: req.user.email };
    if (status) filter.paymentStatus = status;

    const result = await paymentsCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray();
    const total = await paymentsCol.countDocuments(filter);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch payment history" });
  }
});

// ==========================================
// UPLOAD ROUTES  (any authenticated user)
// ==========================================

// POST /upload — receives raw binary body, deduplicates via SHA-256, uploads to Cloudinary
app.post("/upload", verifyToken, async (req, res) => {
  try {
    const mimeType = req.headers["content-type"] || "image/jpeg";
    const folder = req.headers["x-upload-folder"] || "Kino.com";
    const fileName = req.headers["x-upload-filename"] || "upload";

    // Collect raw binary stream — works because express.json() ignores non-JSON content-types
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const buffer = Buffer.concat(chunks);

    if (!buffer.length) {
      return res.status(400).json({ success: false, message: "No file data received" });
    }

    // SHA-256 deduplication check
    const hash = crypto.createHash("sha256").update(buffer).digest("hex");
    const uploadsCol = req.db.collection("cloudinary_uploads");

    const existing = await uploadsCol.findOne({ hash });
    if (existing) {
      return res.status(200).json({
        success: true,
        result: { url: existing.url, public_id: existing.public_id, isDuplicate: true },
      });
    }

    // Upload to Cloudinary as base64 data URI
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

    // Persist upload record for deduplication and ownership tracking
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
        // Race condition: another identical upload completed first
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
    console.error("Upload error:", e);
    return res.status(500).json({ success: false, message: "Upload failed" });
  }
});

// DELETE /upload/*publicId — publicId may contain slashes (e.g. Kino.com/products/abc123)
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
    console.error("Delete error:", e);
    return res.status(500).json({ success: false, message: "Delete failed" });
  }
});

// ==========================================
// SERVER INITIALIZATION
// ==========================================

if (process.env.NODE_ENV !== "production") {
  app.listen(port, async () => {
    await connectToDB(); // Ensure DB connects before accepting requests
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
