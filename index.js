//pnpm add express mongodb jose cors dotenv
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { MongoClient, ServerApiVersion, ObjectId } from "mongodb";
import { createRemoteJWKSet, jwtVerify } from "jose";

dotenv.config();

const app = express();
const port = process.env.PORT || 5000;

const uri = process.env.MONGODB_URI;
const url = 
    process.env.NODE_ENV === "production" ?
    process.env.CLIENT_URL : 
    "http://localhost:3000"

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
});

const JWKS = createRemoteJWKSet(
  new URL(
    `${url}/api/auth/jwks`
  )
)

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
  //   finally {
  //     // Ensures that the client will close when you finish/error
  //     // await client.close();
  //   }
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
    if (!req.user || !req.user.email) {
      return res.status(401).json({ success: false, message: "Not authenticated" });
    }
    const usersCol = req.db.collection("users");
    const user = await usersCol.findOne({ email: req.user.email });

    if (!user || user.role !== "admin") {
      return res.status(403).json({ success: false, message: "Forbidden: Admins only" });
    }
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
    const { sort, order, limit, search, category, status, condition } = req.query;

    const filter = {};
    if (search) filter.title = { $regex: search, $options: "i" }; // Fixed: was filter.name
    if (category) filter.category = category;
    if (status) filter.status = status;
    if (condition) filter.condition = condition;

    const sortObj = {};
    if (sort) {
      const direction = order === "desc" ? -1 : 1;
      if (sort === "price") sortObj.price = direction;
      if (sort === "dateUploaded") sortObj.dateUploaded = direction;
    }

    const limitNum = limit ? parseInt(limit, 10) : 10;

    const result = await productsCol.find(filter).limit(limitNum).sort(sortObj).toArray();

    res.status(200).json({
      success: true,
      message: "Products are loaded successfully",
      result,
    });
  } catch (e) {
    console.error("Load products error:", e);
    res.status(500).json({ success: false, message: "Failed to load products" });
  }
});

app.get("/products/:id", async (req, res) => {
  try {
    const productsCol = req.db.collection("products");
    const { id } = req.params;
    // Fixed: Searching by _id ObjectId instead of string id
    const result = await productsCol.findOne({ _id: new ObjectId(id) });

    if (!result) return res.status(404).json({ success: false, message: "Product not found" });
    res.status(200).json({ success: true, message: "Product info loaded", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to load product" });
  }
});

// ==========================================
// ADMIN PROTECTED ROUTES
// ==========================================

// All /admin routes require valid token AND admin role
app.use("/admin", verifyToken, adminGuard);

// --- STATS ---
app.get("/admin/stats/users", async (req, res) => {
  try {
    const total = await req.db.collection("users").countDocuments();
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

// --- USERS ---
app.get("/admin/users", async (req, res) => {
  try {
    const usersCol = req.db.collection("users");
    const { search, role, sort, order, status } = req.query;
    const { skip, limit } = parsePagination(req.query);

    const filter = {};
    if (search) filter.name = { $regex: search, $options: "i" };
    if (role) filter.role = role;
    if (status) filter.status = status;

    const sortObj = {};
    if (sort) sortObj[sort] = order === "desc" ? -1 : 1;
    else sortObj.createdAt = -1;

    const result = await usersCol.find(filter).sort(sortObj).skip(skip).limit(limit).toArray();
    const total = await usersCol.countDocuments(filter);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch users" });
  }
});

app.patch("/admin/users/:userId/status", async (req, res) => {
  try {
    const { status } = req.body;
    if (!status) return res.status(400).json({ success: false, message: "Status is required" });

    const result = await req.db.collection("users").updateOne(
      { _id: new ObjectId(req.params.userId) },
      { $set: { status } }
    );
    res.status(200).json({ success: true, message: "User status updated", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to update user status" });
  }
});

app.delete("/admin/users/:userId", async (req, res) => {
  try {
    await req.db.collection("users").deleteOne({ _id: new ObjectId(req.params.userId) });
    res.status(200).json({ success: true, message: "User deleted", result: null });
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

    const result = await productsCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray();
    const total = await productsCol.countDocuments(filter);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch products" });
  }
});

app.patch("/admin/products/:productId/status", async (req, res) => {
  try {
    const { status } = req.body;
    const result = await req.db.collection("products").updateOne(
      { _id: new ObjectId(req.params.productId) },
      { $set: { status } }
    );
    res.status(200).json({ success: true, message: "Product status updated", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to update product status" });
  }
});

app.delete("/admin/products/:productId", async (req, res) => {
  try {
    await req.db.collection("products").deleteOne({ _id: new ObjectId(req.params.productId) });
    res.status(200).json({ success: true, message: "Product deleted", result: null });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to delete product" });
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
        { "buyerInfo.email": { $regex: search, $options: "i" } }
      ];
    }

    const result = await ordersCol.find(filter).sort({ _id: -1 }).skip(skip).limit(limit).toArray();
    const total = await ordersCol.countDocuments(filter);

    res.status(200).json({ success: true, result, total });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to fetch orders" });
  }
});

app.patch("/admin/orders/:orderId/status", async (req, res) => {
  try {
    const { status } = req.body;
    const result = await req.db.collection("orders").updateOne(
      { _id: new ObjectId(req.params.orderId) },
      { $set: { orderStatus: status } }
    );
    res.status(200).json({ success: true, message: "Order status updated", result });
  } catch (e) {
    res.status(500).json({ success: false, message: "Failed to update order status" });
  }
});

// --- ANALYTICS ---
app.get("/admin/analytics", async (req, res) => {
  try {
    const ordersCol = req.db.collection("orders");
    const productsCol = req.db.collection("products");
    const usersCol = req.db.collection("users");
    const paymentsCol = req.db.collection("payments");

    const monthlyOrders = await ordersCol.aggregate([
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, count: { $sum: 1 } } },
      { $sort: { _id: 1 } }
    ]).toArray();

    const categoryPerformance = await productsCol.aggregate([
      { $group: { _id: "$category", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();

    const userGrowth = await usersCol.aggregate([
      { $group: { _id: "$role", count: { $sum: 1 } } }
    ]).toArray();

    const revenueByMonth = await paymentsCol.aggregate([
      { $match: { paymentStatus: "success" } },
      { $group: { _id: { $dateToString: { format: "%Y-%m", date: "$createdAt" } }, revenue: { $sum: "$amount" } } },
      { $sort: { _id: 1 } }
    ]).toArray();

    res.status(200).json({
      success: true,
      result: {
        monthlyOrders: monthlyOrders.map(m => ({ month: m._id, count: m.count })),
        categoryPerformance: categoryPerformance.map(c => ({ category: c._id, count: c.count })),
        userGrowth: userGrowth.map(u => ({ month: u._id, count: u.count })),
        revenueByMonth: revenueByMonth.map(r => ({ month: r._id, revenue: r.revenue }))
      }
    });
  } catch (e) {
    console.error("Analytics error:", e);
    res.status(500).json({ success: false, message: "Failed to load analytics" });
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
Vercel initiates a serverless container. This containers code reading flow goes one way, doesn't wait for a nested awaited route definition or nested await functions inside the body of `run` function to return a result, and as soon as the code is read to the end, the undiscovered result remains as null, the code reading finishes and the container shuts down completely. For example: when I'm requesting the "/doctors" url, the run function is busy connecting to the server instance to mongodb. So the request hits the wall, and all the routes remain unregistered, with an unsuccessful 404 code. As soon as the awaited connection is established, the one way code reading flow dashes through all those 404s and reach to the end of code. The containers job is to return with HTTP responses and as much data it can gather meanwhile. Well, because of seeing 404s on every endpoint, the return appears to the end user empty handed.

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
