require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://omnia771148_db_user:Nk1wTwqHMKCzqti7@cluster0.nbhpjuy.mongodb.net/?appName=Cluster0";

app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log("Connected to MongoDB Atlas successfully");
  })
  .catch(err => console.error("MongoDB connection error:", err));

// User Model (explicitly map to the 'users' collection)
const userSchema = new mongoose.Schema({
  phone: { type: String, required: true, unique: true },
  password: { type: String, required: true },
  name: { type: String },
  email: { type: String }
}, { strict: false });

const User = mongoose.model('User', userSchema, 'users');

// Login Endpoint
app.post('/login', async (req, res) => {
  const { phone, password } = req.body;

  if (!phone || !password) {
    return res.status(400).json({ success: false, message: "Phone and password are required" });
  }

  try {
    const user = await User.findOne({ phone }).lean();
    if (!user) {
      return res.status(400).json({ success: false, message: "User not found" });
    }

    if (user.password !== password) {
      return res.status(400).json({ success: false, message: "Invalid password" });
    }

    // Exclude password from the returned user details
    const { password: _, ...userData } = user;

    return res.status(200).json({
      success: true,
      message: "Login successful",
      user: userData
    });
  } catch (err) {
    console.error("Login route error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Restaurant Model (explicitly map to the 'restuarentusers' collection)
const restaurantSchema = new mongoose.Schema({
  restId: { type: String },
  restaurantName: { type: String },
  restLocation: { type: String },
  address: { type: String },
  openTime: { type: String },
  closeTime: { type: String }
}, { strict: false });

const Restaurant = mongoose.model('Restaurant', restaurantSchema, 'restuarentusers');

let cachedRestaurants = null;
let cacheExpiryTime = 0;
const CACHE_DURATION_MS = 10000; // 10 seconds cache duration

// GET /restaurants Endpoint
app.get('/restaurants', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedRestaurants && now < cacheExpiryTime) {
      return res.status(200).json({ success: true, restaurants: cachedRestaurants });
    }

    const restaurants = await Restaurant.find({}).lean();

    // Map AWS S3 URLs to CloudFront CDN for restaurant logo URLs
    const mappedRestaurants = restaurants.map(rest => {
      if (rest.logoUrl) {
        let url = rest.logoUrl;
        url = url.replace(/https:\/\/my-restaurant-buckets\.s3\.[a-z0-9-]+\.amazonaws\.com/i, 'https://d3op3va0hb427u.cloudfront.net');
        url = url.replace('my-restaurant-buckets.s3.eu-north-1.amazonaws.com', 'd3op3va0hb427u.cloudfront.net');
        return { ...rest, logoUrl: url };
      }
      return rest;
    });

    cachedRestaurants = mappedRestaurants;
    cacheExpiryTime = now + CACHE_DURATION_MS;

    return res.status(200).json({ success: true, restaurants: mappedRestaurants });
  } catch (err) {
    console.error("Get restaurants error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /carousel Endpoint
app.get('/carousel', async (req, res) => {
  try {
    const carouselCollection = mongoose.connection.db.collection('carousel');
    const items = await carouselCollection.find({}).toArray();

    // Map AWS S3 URLs to CloudFront CDN
    const mappedItems = items.map(item => {
      if (item.imageUrl) {
        let url = item.imageUrl;
        // Replace:
        // https://my-restaurant-buckets.s3.eu-north-1.amazonaws.com
        // with:
        // https://d3op3va0hb427u.cloudfront.net
        url = url.replace(/https:\/\/my-restaurant-buckets\.s3\.[a-z0-9-]+\.amazonaws\.com/i, 'https://d3op3va0hb427u.cloudfront.net');
        url = url.replace('my-restaurant-buckets.s3.eu-north-1.amazonaws.com', 'd3op3va0hb427u.cloudfront.net');
        return {
          ...item,
          imageUrl: url
        };
      }
      return item;
    });

    return res.status(200).json({ success: true, carousel: mappedItems });
  } catch (err) {
    console.error("Get carousel error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});


// GET /orders/completed/:userId Endpoint
app.get('/orders/completed/:userId', async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ success: false, message: "User ID is required" });
  }

  try {
    const ordersCollection = mongoose.connection.db.collection('finalcompletedorders');
    console.log(`[GET /orders/completed/${userId}] Request received.`);
    const query = {
      $or: [
        { userId: userId }
      ]
    };

    if (mongoose.Types.ObjectId.isValid(userId)) {
      query.$or.push({ userId: new mongoose.Types.ObjectId(userId) });
    }

    console.log(`[GET /orders/completed/${userId}] Querying database:`, JSON.stringify(query));

    // Find all completed orders matching string or objectId format
    const orders = await ordersCollection.find(query).sort({ orderDate: -1 }).toArray();

    return res.status(200).json({ success: true, orders });
  } catch (err) {
    console.error("Get completed orders error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /reviews/user/:userId Endpoint
app.get('/reviews/user/:userId', async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ success: false, message: "User ID is required" });
  }

  try {
    const reviewsCollection = mongoose.connection.db.collection('orderreviews');
    const query = {
      $or: [
        { userId: userId }
      ]
    };

    if (mongoose.Types.ObjectId.isValid(userId)) {
      query.$or.push({ userId: new mongoose.Types.ObjectId(userId) });
    }

    console.log(`[GET /reviews/user/${userId}] Querying database:`, JSON.stringify(query));

    // Aggregate reviews with order details to fetch items list
    const reviews = await reviewsCollection.aggregate([
      { $match: query },
      {
        $lookup: {
          from: 'finalcompletedorders',
          localField: 'orderId',
          foreignField: 'orderId',
          as: 'orderDetails'
        }
      },
      { $sort: { createdAt: -1 } }
    ]).toArray();

    return res.status(200).json({ success: true, reviews });
  } catch (err) {
    console.error("Get user reviews error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// PUT /user/update Endpoint
app.put('/user/update', async (req, res) => {
  const { userid, email, dateOfBirth } = req.body;

  if (!userid) {
    return res.status(400).json({ success: false, message: "User ID is required" });
  }

  try {
    const updateFields = {};
    if (email !== undefined) updateFields.email = email;
    if (dateOfBirth !== undefined) {
      updateFields.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;
    }

    const updatedUser = await User.findByIdAndUpdate(
      userid,
      updateFields,
      { new: true }
    ).lean();

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Exclude password
    const { password: _, ...userData } = updatedUser;

    return res.status(200).json({
      success: true,
      message: "Profile updated successfully",
      user: userData
    });
  } catch (err) {
    console.error("Update profile error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /orderstatus/user/:userid Endpoint
app.get('/orderstatus/user/:userid', async (req, res) => {
  const { userid } = req.params;

  if (!userid) {
    return res.status(400).json({ success: false, message: "User ID is required" });
  }

  try {
    const query = {
      $or: [
        { userId: userid }
      ]
    };

    if (mongoose.Types.ObjectId.isValid(userid)) {
      query.$or.push({ userId: new mongoose.Types.ObjectId(userid) });
    }

    const orderStatusesCollection = mongoose.connection.db.collection('orderstatuses');

    // Query orderstatuses for the latest document matching the user
    const latestStatus = await orderStatusesCollection
      .find(query)
      .sort({ orderDate: -1, createdAt: -1 })
      .limit(1)
      .next();

    return res.status(200).json({ success: true, orderStatus: latestStatus || null });

  } catch (err) {
    console.error("Get order status error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// In-memory cache for mapping restaurantId -> collectionName in the 'restuarents' database
let restaurantIdToCollectionMap = {};

// GET /restaurants/:restaurantId/menu Endpoint
app.get('/restaurants/:restaurantId/menu', async (req, res) => {
  const { restaurantId } = req.params;

  if (!restaurantId) {
    return res.status(400).json({ success: false, message: "Restaurant ID is required" });
  }

  try {
    const db = mongoose.connection.client.db('restuarents');
    let collectionName = restaurantIdToCollectionMap[restaurantId];

    if (!collectionName) {
      const collections = await db.listCollections().toArray();
      for (const colInfo of collections) {
        const col = db.collection(colInfo.name);
        const doc = await col.findOne({ restaurantId });
        if (doc) {
          collectionName = colInfo.name;
          restaurantIdToCollectionMap[restaurantId] = collectionName;
          break;
        }
      }
    }

    if (!collectionName) {
      console.log(`[GET /restaurants/${restaurantId}/menu] No collection found for restaurantId`);
      return res.status(200).json({ success: true, items: [] });
    }

    const itemsCol = db.collection(collectionName);
    const rawItems = await itemsCol.find({}).toArray();

    // Map AWS S3 URLs to CloudFront CDN for items' photo URLs
    const items = rawItems.map(item => {
      if (item.photoUrl) {
        let url = item.photoUrl;
        url = url.replace(/https:\/\/my-restaurant-buckets\.s3\.[a-z0-9-]+\.amazonaws\.com/i, 'https://d3op3va0hb427u.cloudfront.net');
        url = url.replace('my-restaurant-buckets.s3.eu-north-1.amazonaws.com', 'd3op3va0hb427u.cloudfront.net');
        return { ...item, photoUrl: url };
      }
      return item;
    });

    console.log(`[GET /restaurants/${restaurantId}/menu] Found collection '${collectionName}' with ${items.length} items`);
    return res.status(200).json({ success: true, items });

  } catch (err) {
    console.error("Get restaurant menu error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});


// Start Server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

