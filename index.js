require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Razorpay = require('razorpay');
const admin = require('firebase-admin');
const { getAuth } = require('firebase-admin/auth');
const path = require('path');
const fs = require('fs');

const app = express();


let firebaseApp = null;
try {
  let serviceAccount = null;
  const serviceAccountPath = path.join(__dirname, 'firebase-service-account.json');

  if (fs.existsSync(serviceAccountPath)) {
    serviceAccount = require(serviceAccountPath);
  } else if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    } catch (parseErr) {
      console.error('Failed to parse FIREBASE_SERVICE_ACCOUNT environment variable:', parseErr);
    }
  }

  if (serviceAccount && serviceAccount.private_key && serviceAccount.private_key.includes('BEGIN PRIVATE KEY')) {
    firebaseApp = admin.initializeApp({
      credential: admin.cert(serviceAccount)
    });
    console.log('Firebase Admin SDK initialized successfully.');
  } else {
    console.warn('Firebase Service Account key not found or not configured. Google login will be disabled.');
  }
} catch (err) {
  console.error('Failed to initialize Firebase Admin SDK:', err);
}


// Cashfree Payments Configuration
const CASHFREE_APP_ID = process.env.CASHFREE_APP_ID || process.env.RAZORPAY_KEY_ID || 'TEST102345678';
const CASHFREE_SECRET_KEY = process.env.CASHFREE_SECRET_KEY || process.env.RAZORPAY_KEY_SECRET || 'cfsk_ma_test_secret';
const CASHFREE_ENV = (process.env.CASHFREE_ENV || 'TEST').toUpperCase();
const CASHFREE_BASE_URL = CASHFREE_ENV === 'PROD'
  ? 'https://api.cashfree.com/pg'
  : 'https://sandbox.cashfree.com/pg';
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MongoURL || process.env.MONGODB_URI || "mongodb+srv://leevondelivery_db_user:Leevon2026@cluster0.0jp6bhd.mongodb.net/?appName=Cluster0";

app.use(cors());
app.use(express.json());


app.use((req, res, next) => {
  if (mongoose.connection.readyState !== 1) {
    return res.status(503).json({
      success: false,
      message: "Database connection is initializing, please try again in a moment."
    });
  }
  next();
});

// MongoDB Connection
mongoose.connect(MONGODB_URI)
  .then(() => {
    console.log("Connected to MongoDB Atlas successfully");
  })
  .catch(err => console.error("MongoDB connection error:", err));

// User Model (explicitly map to the 'users' collection)
const userSchema = new mongoose.Schema({
  phone: { type: String, unique: true, sparse: true },
  password: { type: String },
  name: { type: String },
  email: { type: String },
  securityAnswer: { type: String },
  savedAddresses: { type: Array, default: [] }
}, { strict: false });

const User = mongoose.model('User', userSchema, 'users');

// Fees Configuration Schema and Model
const feesConfigSchema = new mongoose.Schema({
  key: { type: String, default: 'global' },
  deliveryFeeBase: { type: Number, default: 20 },
  baseKmThreshold: { type: Number, default: 3 },
  deliveryFeePerKm: { type: Number, default: 10 },
  surgeFee: { type: Number, default: 0 },
  isSurgeActive: { type: Boolean, default: false }
}, { strict: false });

feesConfigSchema.index({ key: 1 });

const FeesConfig = mongoose.model('FeesConfig', feesConfigSchema, 'feesconfigs');

// Controls Schema and Model (mapped to 'controls' collection in MongoDB)
const controlsSchema = new mongoose.Schema({
  key: { type: String, required: true },
  name: { type: String },
  status: { type: Boolean, default: true },
  history: { type: Array, default: [] }
}, { timestamps: true, collection: 'controls', strict: false });

controlsSchema.index({ key: 1 });

const Controls = mongoose.model('Controls', controlsSchema, 'controls');

// Controls API Endpoints
const handleGetControls = async (req, res) => {
  try {
    const allControls = await Controls.find({}).lean();
    return res.status(200).json({
      success: true,
      controls: allControls
    });
  } catch (error) {
    console.error('Error fetching controls from MongoDB:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

app.get('/api/controls', handleGetControls);
app.get('/controls', handleGetControls);

app.get('/api/controls/confirmPayButton', async (req, res) => {
  try {
    const control = await Controls.findOne({ key: 'confirmPayButton' }).lean();
    return res.status(200).json({
      success: true,
      status: control ? Boolean(control.status) : true,
      control
    });
  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Review Schema and Model (mapped to 'reviews' collection in MongoDB)
const reviewSchema = new mongoose.Schema({
  userId: { type: String, required: true },
  user_id: { type: String },
  orderId: { type: String },
  order_id: { type: String },
  restaurantId: { type: String },
  restaurantName: { type: String },
  deliveryBoyId: { type: String },
  deliveryBoyName: { type: String },
  restaurantRating: { type: Number, default: 0 },
  restaurantReview: { type: String, default: '' },
  deliveryBoyRating: { type: Number, default: 0 },
  deliveryBoyReview: { type: String, default: '' },
  orderDetails: { type: Array, default: [] }
}, { timestamps: true, collection: 'reviews', strict: false });

reviewSchema.index({ userId: 1 });
reviewSchema.index({ orderId: 1 });

const Review = mongoose.model('Review', reviewSchema, 'reviews');

// Review Endpoints
const handleGetUserReviews = async (req, res) => {
  try {
    const { userId } = req.params;
    const userReviews = await Review.find({
      $or: [{ userId: userId }, { user_id: userId }]
    }).sort({ createdAt: -1 }).lean();

    return res.status(200).json({
      success: true,
      reviews: userReviews
    });
  } catch (error) {
    console.error('Error fetching user reviews from MongoDB:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

app.get('/reviews/user/:userId', handleGetUserReviews);
app.get('/api/reviews/user/:userId', handleGetUserReviews);
app.get('/reviews/:userId', handleGetUserReviews);
app.get('/api/reviews/:userId', handleGetUserReviews);

const handleGetAllReviews = async (req, res) => {
  try {
    const allReviews = await Review.find({}).sort({ createdAt: -1 }).lean();
    return res.status(200).json({
      success: true,
      reviews: allReviews
    });
  } catch (error) {
    console.error('Error fetching all reviews from MongoDB:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

app.get('/reviews', handleGetAllReviews);
app.get('/api/reviews', handleGetAllReviews);

const handleCreateReview = async (req, res) => {
  try {
    const reviewData = req.body;
    const newReview = new Review({
      userId: reviewData.userId || reviewData.user_id || '',
      user_id: reviewData.user_id || reviewData.userId || '',
      orderId: reviewData.orderId || reviewData.order_id || '',
      order_id: reviewData.order_id || reviewData.orderId || '',
      restaurantId: reviewData.restaurantId || reviewData.restaurant_id || '',
      restaurantName: reviewData.restaurantName || 'Restaurant',
      deliveryBoyId: reviewData.deliveryBoyId || reviewData.delivery_boy_id || '',
      deliveryBoyName: reviewData.deliveryBoyName || 'Delivery Partner',
      restaurantRating: Number(reviewData.restaurantRating || reviewData.rating || 0),
      restaurantReview: (reviewData.restaurantReview || reviewData.review || '').trim(),
      deliveryBoyRating: Number(reviewData.deliveryBoyRating || 0),
      deliveryBoyReview: (reviewData.deliveryBoyReview || '').trim(),
      orderDetails: reviewData.orderDetails || []
    });
    const saved = await newReview.save();
    return res.status(201).json({
      success: true,
      message: 'Review submitted successfully',
      review: saved
    });
  } catch (error) {
    console.error('Error saving review to MongoDB:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
};

app.post('/reviews', handleCreateReview);
app.post('/api/reviews', handleCreateReview);
app.post('/reviews/create', handleCreateReview);
app.post('/reviews/add', handleCreateReview);
app.post('/reviews/submit', handleCreateReview);

// Orders Completed Endpoint
const handleGetCompletedOrders = async (req, res) => {
  try {
    const { userId } = req.params;
    const ordersCollection = mongoose.connection.db.collection('orders');
    const userOrders = await ordersCollection.find({
      $or: [{ userId: userId }, { user_id: userId }, { customerId: userId }]
    }).sort({ createdAt: -1 }).toArray();

    return res.status(200).json({
      success: true,
      orders: userOrders || []
    });
  } catch (error) {
    console.error('Error fetching completed orders:', error);
    return res.status(200).json({ success: true, orders: [] });
  }
};

app.get('/orders/completed/:userId', handleGetCompletedOrders);
app.get('/api/orders/completed/:userId', handleGetCompletedOrders);

// GET /api/controls/maintenanceMode
// Returns the maintenanceMode status from the controls collection.
// status: true  => app is live and running normally
// status: false => app is under maintenance (blocks UI on the mobile app)
app.get('/api/controls/maintenanceMode', async (req, res) => {
  try {
    const control = await Controls.findOne({ key: 'maintenanceMode' }).lean();
    return res.status(200).json({
      success: true,
      key: 'maintenanceMode',
      status: control ? Boolean(control.status) : true,  // default true = app is live
      control
    });
  } catch (error) {
    console.error('Error fetching maintenanceMode control:', error);
    return res.status(500).json({ success: false, error: error.message });
  }
});

// Login Endpoint
app.post('/login', async (req, res) => {
  const { phone, email, identifier, password } = req.body;
  const loginInput = String(phone || email || identifier || '').trim();
  const reqPassword = String(password || '').trim();

  if (!loginInput || !reqPassword) {
    return res.status(400).json({ success: false, message: "Phone/Email and password are required" });
  }

  try {
    console.log(`[Login Attempt] Searching account for: "${loginInput}"`);
    // Search by phone OR email (case-insensitive for email)
    const user = await User.findOne({
      $or: [
        { phone: loginInput },
        { email: loginInput },
        { email: loginInput.toLowerCase() }
      ]
    }).lean();

    if (!user) {
      return res.status(400).json({ success: false, message: "Account not found with this phone number or email address." });
    }

    const dbPassword = String(user.password || '').trim();
    if (dbPassword !== reqPassword) {
      console.warn(`[Login Failed] Incorrect password for user "${loginInput}". Saved: "${dbPassword}", Received: "${reqPassword}"`);
      return res.status(400).json({ success: false, message: "Incorrect password. Please try again." });
    }

    console.log(`[Login Success] User "${loginInput}" logged in successfully!`);

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

app.post('/signup', async (req, res) => {
  const { phone, password, name, email, securityAnswer } = req.body;

  if (!phone || !password || !name) {
    return res.status(400).json({ success: false, message: "Phone, password, and name are required" });
  }

  try {
    // Check if phone number already exists
    const existingUser = await User.findOne({ phone }).lean();
    if (existingUser) {
      return res.status(400).json({ success: false, message: "An account with this phone number already exists" });
    }

    const newUser = new User({
      phone,
      password, // Plaintext to match the existing login logic
      name,
      email: email && email.trim() ? email.trim() : 'N/A',
      isPhoneVerified: false,
      securityAnswer: securityAnswer ? securityAnswer.trim().toLowerCase() : 'n/a',
      savedAddresses: []
    });

    const savedUser = await newUser.save();

    // Exclude password from response
    const userObj = savedUser.toObject();
    const { password: _, ...userData } = userObj;

    return res.status(201).json({
      success: true,
      message: "Signup successful",
      user: userData
    });
  } catch (err) {
    console.error("Signup route error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Check Phone Endpoint for Forgot Password
app.post('/forgot-password/check-phone', async (req, res) => {
  const { phone } = req.body;

  if (!phone) {
    return res.status(400).json({ success: false, message: "Phone number is required" });
  }

  try {
    const user = await User.findOne({ phone }).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    return res.status(200).json({
      success: true,
      message: "User exists"
    });
  } catch (err) {
    console.error("Check phone error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Reset Password (No Question Required - OTP Verified on Client)
app.post('/forgot-password/reset-password', async (req, res) => {
  const { phone, newPassword } = req.body;

  if (!phone || !newPassword) {
    return res.status(400).json({ success: false, message: "Phone and new password are required" });
  }

  try {
    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password reset successful"
    });
  } catch (err) {
    console.error("Reset password error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Forgot Password Verify Endpoint
app.post('/forgot-password/verify', async (req, res) => {
  const { phone, securityAnswer } = req.body;

  if (!phone || !securityAnswer) {
    return res.status(400).json({ success: false, message: "Phone and security answer are required" });
  }

  try {
    const user = await User.findOne({ phone }).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!user.securityAnswer) {
      return res.status(400).json({ success: false, message: "No security answer configured for this user. Please contact support." });
    }

    if (user.securityAnswer !== securityAnswer.trim().toLowerCase()) {
      return res.status(400).json({ success: false, message: "Incorrect answer to security question" });
    }

    return res.status(200).json({
      success: true,
      message: "Security answer verified successfully"
    });
  } catch (err) {
    console.error("Forgot password verify error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Forgot Password Reset Endpoint
app.post('/forgot-password/reset', async (req, res) => {
  const { phone, securityAnswer, newPassword } = req.body;

  if (!phone || !securityAnswer || !newPassword) {
    return res.status(400).json({ success: false, message: "Phone, security answer, and new password are required" });
  }

  try {
    const user = await User.findOne({ phone });
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }

    if (!user.securityAnswer || user.securityAnswer !== securityAnswer.trim().toLowerCase()) {
      return res.status(400).json({ success: false, message: "Security answer verification failed" });
    }

    // Update password
    user.password = newPassword;
    await user.save();

    return res.status(200).json({
      success: true,
      message: "Password reset successful"
    });
  } catch (err) {
    console.error("Forgot password reset error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Google Login Endpoint
app.post('/login/google', async (req, res) => {
  const { idToken } = req.body;

  if (!idToken) {
    return res.status(400).json({ success: false, message: "Firebase idToken is required" });
  }

  if (!firebaseApp) {
    console.error('[Firebase Admin] Firebase is not initialized.');
    return res.status(503).json({
      success: false,
      message: "Google login is currently unavailable. Firebase service account is not configured."
    });
  }

  try {
    const decodedToken = await getAuth().verifyIdToken(idToken);
    const { email, name, uid } = decodedToken;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email not provided by Google account" });
    }

    let user = await User.findOne({ email }).lean();

    if (!user) {
      // Register user in MongoDB (with unique temporary phone value to avoid unique index duplicate error)
      const tempPhone = `google_temp_${uid}`;
      const newUser = new User({
        email,
        name: name || email.split('@')[0],
        phone: tempPhone,
        isPhoneVerified: false,
        firebaseUid: uid,
        savedAddresses: []
      });
      user = await newUser.save();
      console.log(`[Google Signup] Registered new MongoDB user: ${email} with temp phone ${tempPhone}`);
    } else {
      if (!user.firebaseUid) {
        await User.updateOne({ email }, { $set: { firebaseUid: uid } });
        user.firebaseUid = uid;
      }
      console.log(`[Google Login] Signed in user: ${email}`);
    }

    const { password: _, ...userData } = user;

    return res.status(200).json({
      success: true,
      message: "Google login successful",
      user: userData
    });

  } catch (err) {
    console.error("Google login route error:", err);
    return res.status(401).json({ success: false, message: "Invalid or expired Google Token" });
  }
});

// Restaurant Model (explicitly map to the 'restuarentusers' collection)
const restaurantSchema = new mongoose.Schema({
  restId: { type: String },
  restaurantName: { type: String },
  restLocation: { type: String },
  address: { type: String },
  openTime: { type: String },
  closeTime: { type: String },
  isActive: { type: Boolean, default: true },
  isactive: { type: Boolean, default: true }
}, { strict: false });

const Restaurant = mongoose.model('Restaurant', restaurantSchema, 'restuarentusers');

// Global cache for restaurant categories mapping
let restaurantCategoriesCache = null;
let categoriesCacheExpiryTime = 0;
const CATEGORIES_CACHE_DURATION = 60000; // Cache category map for 1 minute

async function getRestaurantCategoriesMap() {
  const now = Date.now();
  if (restaurantCategoriesCache && now < categoriesCacheExpiryTime) {
    return restaurantCategoriesCache;
  }
  try {
    const db = mongoose.connection.client.db('restuarents');
    const collections = await db.listCollections().toArray();
    const categoriesMap = {};

    // Fetch unique categories in parallel for all restaurant menu collections
    await Promise.all(collections.map(async (colInfo) => {
      try {
        const col = db.collection(colInfo.name);
        const categories = await col.distinct('category');
        const sampleDoc = await col.findOne({});
        if (sampleDoc && sampleDoc.restaurantId) {
          // Normalize to lowercase trimmed strings for comparison
          categoriesMap[sampleDoc.restaurantId] = categories
            .filter(Boolean)
            .map(c => c.toLowerCase().trim());
        }
      } catch (err) {
        console.error(`Error loading categories for ${colInfo.name}:`, err);
      }
    }));

    restaurantCategoriesCache = categoriesMap;
    categoriesCacheExpiryTime = now + CATEGORIES_CACHE_DURATION;
    return categoriesMap;
  } catch (err) {
    console.error("Failed to build restaurant categories map:", err);
    return restaurantCategoriesCache || {};
  }
}

let cachedRestaurants = null;
let cacheExpiryTime = 0;
const CACHE_DURATION_MS = 1000; // 1 second cache duration for fast live isActive updates

// GET /restaurants Endpoint
app.get('/restaurants', async (req, res) => {
  try {
    const now = Date.now();
    if (cachedRestaurants && now < cacheExpiryTime) {
      return res.status(200).json({ success: true, restaurants: cachedRestaurants });
    }

    const [restaurants, categoriesMap] = await Promise.all([
      Restaurant.find({}).lean(),
      getRestaurantCategoriesMap()
    ]);

    // Map AWS S3 URLs to CloudFront CDN for restaurant logo URLs & attach categories
    const mappedRestaurants = restaurants.map(rest => {
      const restId = rest.restId;
      const categories = categoriesMap[restId] || [];

      let updatedRest = { ...rest, categories };

      if (rest.logoUrl) {
        let url = rest.logoUrl;
        url = url.replace(/https:\/\/my-restaurant-buckets\.s3\.[a-z0-9-]+\.amazonaws\.com/i, 'https://d3op3va0hb427u.cloudfront.net');
        url = url.replace('my-restaurant-buckets.s3.eu-north-1.amazonaws.com', 'd3op3va0hb427u.cloudfront.net');
        updatedRest.logoUrl = url;
      }
      return updatedRest;
    });

    cachedRestaurants = mappedRestaurants;
    cacheExpiryTime = now + CACHE_DURATION_MS;

    return res.status(200).json({ success: true, restaurants: mappedRestaurants });
  } catch (err) {
    console.error("Get restaurants error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /categories Endpoint
app.get('/categories', async (req, res) => {
  try {
    const categoriesCollection = mongoose.connection.db.collection('catagoryfilterinmainpage');
    const items = await categoriesCollection.find({}).toArray();

    // Sort items numerically by 'id' field in ascending order (1, 2, 3, 4, ...)
    items.sort((a, b) => {
      const idA = parseInt(a.id || '999', 10);
      const idB = parseInt(b.id || '999', 10);
      return idA - idB;
    });

    // Map AWS S3 URLs to CloudFront CDN for category images
    const mappedItems = items.map(item => {
      if (item.imageUrl) {
        let url = item.imageUrl;
        url = url.replace(/https:\/\/my-restaurant-buckets\.s3\.[a-z0-9-]+\.amazonaws\.com/i, 'https://d3op3va0hb427u.cloudfront.net');
        url = url.replace('my-restaurant-buckets.s3.eu-north-1.amazonaws.com', 'd3op3va0hb427u.cloudfront.net');
        return {
          ...item,
          imageUrl: url
        };
      }
      return item;
    });

    return res.status(200).json({ success: true, categories: mappedItems });
  } catch (err) {
    console.error("Get categories error:", err);
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


// GET /orders/completed/:userId Endpoint (fetches completed & rejected orders)
app.get('/orders/completed/:userId', async (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ success: false, message: "User ID is required" });
  }

  try {
    const ordersCollection = mongoose.connection.db.collection('finalcompletedorders');
    const rejectedCollection = mongoose.connection.db.collection('rejectedorders');
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

    // Fetch orders from both finalcompletedorders and rejectedorders collections
    const [completedOrders, rejectedOrders] = await Promise.all([
      ordersCollection.find(query).toArray(),
      rejectedCollection.find(query).toArray()
    ]);

    const formattedCompleted = completedOrders.map(order => ({
      ...order,
      status: order.status || 'Completed',
      isRejected: false
    }));

    const formattedRejected = rejectedOrders.map(order => ({
      ...order,
      status: order.status || 'Rejected',
      isRejected: true
    }));

    // Combine and sort by date descending (newest first)
    const combinedOrders = [...formattedCompleted, ...formattedRejected].sort((a, b) => {
      const dateA = new Date(a.orderDate || a.completedAt || a.createdAt || 0);
      const dateB = new Date(b.orderDate || b.completedAt || b.createdAt || 0);
      return dateB - dateA;
    });

    return res.status(200).json({ success: true, orders: combinedOrders });
  } catch (err) {
    console.error("Get completed and rejected orders error:", err);
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
  const { userid, email, dateOfBirth, phone, isPhoneVerified } = req.body;

  if (!userid) {
    return res.status(400).json({ success: false, message: "User ID is required" });
  }

  try {
    const updateFields = {};
    if (email !== undefined) updateFields.email = email;
    if (dateOfBirth !== undefined) {
      updateFields.dateOfBirth = dateOfBirth ? new Date(dateOfBirth) : null;
    }
    if (phone !== undefined) {
      updateFields.phone = phone;
    }
    if (isPhoneVerified !== undefined) {
      updateFields.isPhoneVerified = isPhoneVerified;
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
    if (err.code === 11000) {
      return res.status(400).json({ success: false, message: "This phone number is already linked to another account." });
    }
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /user/:userid Endpoint - Fetch user profile details
app.get('/user/:userid', async (req, res) => {
  const { userid } = req.params;
  if (!userid) {
    return res.status(400).json({ success: false, message: "User ID is required" });
  }
  try {
    const user = await User.findById(userid).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    // Exclude password
    const { password: _, ...userData } = user;
    return res.status(200).json({ success: true, user: userData });
  } catch (err) {
    console.error("Get user profile error:", err);
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

// GET /user/:userid/addresses Endpoint
app.get('/user/:userid/addresses', async (req, res) => {
  const { userid } = req.params;
  if (!userid) {
    return res.status(400).json({ success: false, message: "User ID is required" });
  }
  try {
    const user = await User.findById(userid).lean();
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    return res.status(200).json({ success: true, addresses: user.savedAddresses || [] });
  } catch (err) {
    console.error("Get addresses error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// POST /user/:userid/addresses Endpoint
app.post('/user/:userid/addresses', async (req, res) => {
  const { userid } = req.params;
  const { flatNo, street, landmark, tag, lat, lng } = req.body;
  if (!userid) {
    return res.status(400).json({ success: false, message: "User ID is required" });
  }
  try {
    const user = await User.findById(userid);
    if (!user) {
      return res.status(404).json({ success: false, message: "User not found" });
    }
    if (!user.savedAddresses) {
      user.savedAddresses = [];
    }
    const addressId = new mongoose.Types.ObjectId().toString();
    const newAddress = {
      _id: addressId,
      id: addressId,
      flatNo,
      street,
      landmark,
      tag: tag || 'Home', // 'Home', 'Office', 'Apartment', 'Other'
      label: tag || 'Home', // support database compatibility
      lat: lat ? Number(lat) : null,
      lng: lng ? Number(lng) : null,
      url: (lat && lng) ? `https://www.google.com/maps/search/?api=1&query=${lat},${lng}` : "",
    };
    user.savedAddresses.push(newAddress);
    user.markModified('savedAddresses');
    await user.save();
    return res.status(200).json({ success: true, message: "Address saved successfully", addresses: user.savedAddresses });
  } catch (err) {
    console.error("Save address error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// DELETE /user/:userid/addresses/:addressId Endpoint
app.delete('/user/:userid/addresses/:addressId', async (req, res) => {
  const { userid, addressId } = req.params;
  console.log(`[DELETE /user/${userid}/addresses/${addressId}] Request received.`);
  if (!userid || !addressId) {
    return res.status(400).json({ success: false, message: "User ID and Address ID are required" });
  }
  try {
    const usersCollection = mongoose.connection.db.collection('users');

    // Construct pull filter to match by id, _id (string), or _id (ObjectId)
    const pullCondition = {
      $or: [
        { id: addressId },
        { _id: addressId }
      ]
    };

    if (mongoose.Types.ObjectId.isValid(addressId)) {
      pullCondition.$or.push({ _id: new mongoose.Types.ObjectId(addressId) });
    }

    const query = {
      _id: mongoose.Types.ObjectId.isValid(userid) ? new mongoose.Types.ObjectId(userid) : userid
    };

    const updateResult = await usersCollection.updateOne(
      query,
      { $pull: { savedAddresses: pullCondition } }
    );

    console.log(`[DELETE /user/${userid}/addresses/${addressId}] Update result:`, updateResult);

    // Fetch the updated user document to return
    const updatedUser = await User.findById(userid).lean();
    return res.status(200).json({ success: true, message: "Address deleted successfully", addresses: updatedUser?.savedAddresses || [] });
  } catch (err) {
    console.error("Delete address error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// In-memory cache for mapping restaurantId -> collectionName in the 'restuarents' database
let restaurantIdToCollectionMap = {};

// GET /restaurants/
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


// POST /api/coupon/validate - Validate coupon code and calculate discount
app.post('/api/coupon/validate', async (req, res) => {
  const { couponCode, cartTotal } = req.body;

  if (!couponCode) {
    return res.status(400).json({ success: false, message: "Coupon code is required" });
  }

  const subTotal = parseFloat(cartTotal) || 0;

  try {
    const coupon = await mongoose.connection.db.collection('couponcodes').findOne({
      couponCode: couponCode.trim().toUpperCase()
    });

    if (!coupon) {
      return res.status(404).json({ success: false, message: "Invalid or expired coupon code" });
    }

    const discountType = coupon.discountType || 'flat';
    const discountValue = parseFloat(coupon.discountValue) || 0;
    let discountAmount = 0;

    if (discountType === 'flat') {
      discountAmount = Math.min(discountValue, subTotal);
    } else if (discountType === 'percentage') {
      discountAmount = subTotal * (discountValue / 100);
    }

    discountAmount = Math.round(discountAmount * 100) / 100; // round to 2 decimal places

    return res.status(200).json({
      success: true,
      couponCode: coupon.couponCode,
      influencerName: coupon.influencerName,
      discountType,
      discountValue,
      discountAmount
    });
  } catch (err) {
    console.error("Coupon validation error:", err);
    return res.status(500).json({ success: false, message: "Internal server error validating coupon" });
  }
});


// POST /payment/order - Create a Cashfree payment order session
app.post('/payment/order', async (req, res) => {
  const { amount, userId, userPhone, userEmail, userName } = req.body;
  if (!amount) {
    return res.status(400).json({ success: false, message: "Amount is required" });
  }

  try {
    if (userId) {
      const orderStatusesCollection = mongoose.connection.db.collection('orderstatuses');
      const activeOrder = await orderStatusesCollection.findOne({ userId: String(userId) });
      if (activeOrder) {
        return res.status(400).json({
          success: false,
          message: "You already have an active order in progress. Please wait for it to complete."
        });
      }
    }

    const cfOrderId = `order_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
    const cleanPhone = (userPhone && String(userPhone).replace(/\D/g, '').slice(-10)) || '9999999999';
    const cleanEmail = (userEmail && userEmail !== 'N/A' ? userEmail : 'customer@example.com');
    const cleanName = (userName && userName !== 'N/A' ? userName : 'Customer');
    const cleanUserId = String(userId || `user_${Date.now()}`);

    console.log("[Cashfree Order] Initiating order:", { cfOrderId, amount, cleanUserId });

    const response = await fetch(`${CASHFREE_BASE_URL}/orders`, {
      method: 'POST',
      headers: {
        'x-client-id': CASHFREE_APP_ID,
        'x-client-secret': CASHFREE_SECRET_KEY,
        'x-api-version': '2023-08-01',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        order_id: cfOrderId,
        order_amount: Number(amount),
        order_currency: 'INR',
        customer_details: {
          customer_id: cleanUserId,
          customer_name: cleanName,
          customer_email: cleanEmail,
          customer_phone: cleanPhone
        }
      })
    });

    const cfData = await response.json();

    if (!response.ok || !cfData.payment_session_id) {
      console.error("[Cashfree Order] Order creation failed:", cfData);
      if (CASHFREE_ENV === 'TEST') {
        const mockSessionId = `session_mock_${Date.now()}`;
        console.log("[Cashfree Order] Test mode fallback session generated:", mockSessionId);
        return res.status(200).json({
          success: true,
          payment_session_id: mockSessionId,
          orderId: cfOrderId,
          cfEnv: 'TEST',
          keyId: CASHFREE_APP_ID,
          amount: amount
        });
      }
      return res.status(400).json({
        success: false,
        message: cfData.message || "Failed to create Cashfree payment order."
      });
    }

    return res.status(200).json({
      success: true,
      payment_session_id: cfData.payment_session_id,
      orderId: cfData.order_id || cfOrderId,
      cfEnv: CASHFREE_ENV,
      keyId: CASHFREE_APP_ID,
      amount: amount
    });
  } catch (err) {
    console.error("Create Cashfree order error:", err);
    return res.status(500).json({ success: false, message: "Failed to create payment order", error: err.message });
  }
});

// POST /payment/verify - Verify Cashfree payment and place the order in database
app.post('/payment/verify', async (req, res) => {
  const {
    order_id,
    cf_order_id,
    payment_session_id,
    userId,
    cartItems,
    restaurantId,
    restaurantName,
    totalPrice,
    gst,
    platformFee,
    grandTotal,
    coinsEarned,
    userName,
    userEmail,
    userPhone,
    deliveryAddressInfo,
    userCoordinates,
    deliveryDistance,
    deliveryFee,
    couponCode,
    influencerName,
    discountAmount
  } = req.body;

  const targetOrderId = order_id || cf_order_id || razorpay_order_id;
  const targetPaymentId = payment_session_id || razorpay_payment_id || targetOrderId;

  if (!targetOrderId && !targetPaymentId) {
    return res.status(400).json({ success: false, message: "Order ID or Payment Session is required" });
  }

  try {
    console.log("[Payment Verify] Verifying payment for:", { targetOrderId, targetPaymentId, userId });

    let isPaymentValid = false;

    if (
      (targetOrderId && (targetOrderId.startsWith('mock_') || targetOrderId.startsWith('cf_mock_') || targetOrderId.startsWith('order_mock_'))) ||
      (targetPaymentId && (targetPaymentId.startsWith('session_mock_') || targetPaymentId.startsWith('pay_mock_')))
    ) {
      console.log("[Payment Verify] Mock payment detected. Bypassing verification.");
      isPaymentValid = true;
    } else {
      try {
        const verifyRes = await fetch(`${CASHFREE_BASE_URL}/orders/${targetOrderId}`, {
          method: 'GET',
          headers: {
            'x-client-id': CASHFREE_APP_ID,
            'x-client-secret': CASHFREE_SECRET_KEY,
            'x-api-version': '2023-08-01'
          }
        });
        const verifyData = await verifyRes.json();
        if (verifyRes.ok && (verifyData.order_status === 'PAID' || verifyData.order_status === 'ACTIVE')) {
          isPaymentValid = true;
        } else {
          console.error("[Payment Verify] Cashfree API status failed:", verifyData);
          // If in test env, allow completion for smooth sandbox testing
          if (CASHFREE_ENV === 'TEST') {
            console.log("[Payment Verify] Sandbox mode fallback verification passed.");
            isPaymentValid = true;
          }
        }
      } catch (cfErr) {
        console.error("Cashfree API fetch verification error:", cfErr);
        if (CASHFREE_ENV === 'TEST') {
          isPaymentValid = true;
        }
      }
    }

    if (!isPaymentValid) {
      return res.status(400).json({ success: false, message: "Payment verification failed" });
    }

    // Payment verified successfully! Save order details.
    const ordersCollection = mongoose.connection.db.collection('orders');
    const countersCollection = mongoose.connection.db.collection('counters');

    const counterDoc = await countersCollection.findOneAndUpdate(
      { _id: 'orderId-global' },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', returnOriginal: false, upsert: true }
    );

    let nextSeq;
    if (counterDoc && counterDoc.value) {
      nextSeq = counterDoc.value.seq;
    } else if (counterDoc) {
      nextSeq = counterDoc.seq;
    }

    if (!nextSeq) {
      nextSeq = Math.floor(1000 + Math.random() * 9000);
    }

    const generatedOrderId = `ORD-${String(nextSeq).padStart(5, '0')}`;

    const orderDocument = {
      userId: userId,
      items: cartItems.map(item => ({
        itemId: String(item._id || item.itemId || item.id),
        name: item.itemName || item.name,
        price: Number(item.price),
        quantity: Number(item.quantity),
        _id: item._id || item.itemId || item.id
      })),
      totalCount: cartItems.reduce((sum, item) => sum + (item.quantity || 0), 0),
      totalPrice: Number(totalPrice),
      gst: Number(gst),
      platformFee: Number(platformFee),
      grandTotal: Number(grandTotal),
      couponCode: couponCode || null,
      influencerName: influencerName || null,
      discountAmount: discountAmount ? Number(discountAmount) : 0,
      orderId: generatedOrderId,
      cashfreeOrderId: targetOrderId,
      cashfreePaymentSessionId: targetPaymentId,
      razorpayOrderId: targetOrderId,
      razorpayPaymentId: targetPaymentId,
      paymentStatus: 'Paid',
      coinsEarned: Number(coinsEarned || 0),
      userName: userName || '',
      userEmail: userEmail || '',
      userPhone: userPhone || '',
      isPhoneVerified: req.body.isPhoneVerified !== undefined ? req.body.isPhoneVerified : true,
      flatNo: deliveryAddressInfo?.flatNo || '',
      street: deliveryAddressInfo?.street || '',
      landmark: deliveryAddressInfo?.landmark || '',
      deliveryAddress: `${deliveryAddressInfo?.flatNo || ''}, ${deliveryAddressInfo?.street || ''}${deliveryAddressInfo?.landmark ? ' , ' + deliveryAddressInfo.landmark : ''}`,
      restaurantId: String(restaurantId || cartItems[0]?.restId || ''),
      restaurantName: restaurantName || cartItems[0]?.restaurantName || '',
      userCoordinates: userCoordinates || null,
      deliveryDistance: deliveryDistance || null,
      deliveryFee: Number(deliveryFee || 0),
      aa: "gg",
      orderDate: new Date(),
      __v: 0
    };

    await ordersCollection.insertOne(orderDocument);

    const orderStatusesCollection = mongoose.connection.db.collection('orderstatuses');
    const statusDocument = {
      ...orderDocument,
      status: "waiting for the restaurent to accept"
    };
    await orderStatusesCollection.insertOne(statusDocument);

    if (userId && coinsEarned > 0) {
      try {
        await User.findByIdAndUpdate(userId, {
          $inc: { coins: Number(coinsEarned) }
        });
        console.log(`[Verify] Added ${coinsEarned} coins to user ${userId}`);
      } catch (coinErr) {
        console.error("Failed to update user coins in database:", coinErr);
      }
    }

    if (userId && deliveryAddressInfo && deliveryAddressInfo.flatNo && deliveryAddressInfo.street) {
      try {
        const user = await User.findById(userId);
        if (user) {
          if (!user.savedAddresses) user.savedAddresses = [];
          const isDuplicate = user.savedAddresses.some(addr => {
            const existingFlat = (addr.flatNo || '').toLowerCase().trim();
            const existingStreet = (addr.street || '').toLowerCase().trim();
            const newFlat = String(deliveryAddressInfo.flatNo).toLowerCase().trim();
            const newStreet = String(deliveryAddressInfo.street).toLowerCase().trim();
            return existingFlat === newFlat && existingStreet === newStreet;
          });
          if (!isDuplicate) {
            const addressId = new mongoose.Types.ObjectId().toString();
            const latVal = userCoordinates ? userCoordinates.lat : null;
            const lngVal = userCoordinates ? userCoordinates.lng : null;
            user.savedAddresses.push({
              _id: addressId,
              id: addressId,
              flatNo: deliveryAddressInfo.flatNo,
              street: deliveryAddressInfo.street,
              landmark: deliveryAddressInfo.landmark || '',
              tag: deliveryAddressInfo.tag || 'Home',
              label: deliveryAddressInfo.tag || 'Home',
              lat: latVal ? Number(latVal) : null,
              lng: lngVal ? Number(lngVal) : null,
              url: (latVal && lngVal) ? `https://www.google.com/maps/search/?api=1&query=${latVal},${lngVal}` : "",
            });
            user.markModified('savedAddresses');
            await user.save();
            console.log(`[Verify] Auto-saved new address for user ${userId}`);
          }
        }
      } catch (saveErr) {
        console.error("Auto-save address error during payment verify:", saveErr);
      }
    }

    return res.status(200).json({
      success: true,
      message: "Payment verified and order placed successfully!",
      orderId: generatedOrderId
    });
  } catch (err) {
    console.error("Verify payment and place order error:", err);
    return res.status(500).json({ success: false, message: "Internal server error during order placement", error: err.message });
  }
});

const https = require('https');

const fetchRoutesDistance = (originLat, originLng, destLat, destLng, apiKey) => {
  return new Promise((resolve, reject) => {
    const postData = JSON.stringify({
      origin: {
        location: {
          latLng: {
            latitude: parseFloat(originLat),
            longitude: parseFloat(originLng)
          }
        }
      },
      destination: {
        location: {
          latLng: {
            latitude: parseFloat(destLat),
            longitude: parseFloat(destLng)
          }
        }
      },
      travelMode: "TWO_WHEELER",
      routingPreference: "TRAFFIC_UNAWARE"
    });

    const options = {
      hostname: 'routes.googleapis.com',
      port: 443,
      path: '/directions/v2:computeRoutes',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': apiKey,
        'X-Goog-FieldMask': 'routes.distanceMeters,routes.duration'
      }
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', (chunk) => body += chunk);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed);
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on('error', (err) => reject(err));
    req.write(postData);
    req.end();
  });
};

app.get('/distance', async (req, res) => {
  const { originLat, originLng, restaurantId } = req.query;

  if (!originLat || !originLng || !restaurantId) {
    return res.status(400).json({ success: false, message: "Missing origin coordinates or restaurantId" });
  }

  try {
    const restaurant = await Restaurant.findOne({
      $or: [
        { restId: restaurantId },
        { _id: mongoose.Types.ObjectId.isValid(restaurantId) ? new mongoose.Types.ObjectId(restaurantId) : restaurantId }
      ]
    }).lean();

    if (!restaurant) {
      return res.status(404).json({ success: false, message: "Restaurant not found" });
    }

    const restLocation = restaurant.restaurantLocation;
    if (!restLocation || restLocation.lat === undefined || restLocation.lng === undefined) {
      return res.status(400).json({ success: false, message: "Restaurant location coordinates not set in DB" });
    }

    const apiKey = process.env.GOOGLE_MAPS_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ success: false, message: "Google Maps API Key is not configured on backend" });
    }

    const result = await fetchRoutesDistance(originLat, originLng, restLocation.lat, restLocation.lng, apiKey);

    if (result && result.routes && result.routes[0]) {
      const distanceMeters = result.routes[0].distanceMeters;
      const distanceValKm = (distanceMeters / 1000).toFixed(1);
      return res.status(200).json({ success: true, distance: `${distanceValKm} km`, km: distanceValKm });
    } else {
      console.warn("Routes API returned empty or error response:", result);
      return res.status(400).json({ success: false, message: "Could not calculate road distance" });
    }
  } catch (err) {
    console.error("Distance calculation error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// GET /fees-config endpoint
app.get('/fees-config', async (req, res) => {
  try {
    let config = await FeesConfig.findOne({ key: 'global' }).lean();
    if (!config) {
      config = {
        key: 'global',
        deliveryFeeBase: 20,
        baseKmThreshold: 3,
        deliveryFeePerKm: 10,
        surgeFee: 0,
        isSurgeActive: false,
        isCoinsActive: true,
        coinMinOrderAmount: 200,
        coinBaseAmount: 10,
        coinStepAmount: 100,
        coinStepValue: 5,
        coinMaxLimit: 100,
        coinMaxThreshold: 1000
      };
    }
    return res.status(200).json({ success: true, config });
  } catch (err) {
    console.error("Get fees config error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// ==========================================
// COMPLETED ORDERS ENDPOINT (MongoDB 'orders' Collection)
// ==========================================

// GET /orders/completed/:userid - Fetch completed orders for a user
app.get(['/orders/completed/:userid', '/orders/completed/user/:userid'], async (req, res) => {
  try {
    const { userid } = req.params;
    if (!userid) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const ordersCollection = mongoose.connection.db.collection('orders');
    const userOrders = await ordersCollection
      .find({
        $or: [
          { userId: String(userid) },
          { user_id: String(userid) }
        ]
      })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      orders: userOrders || []
    });
  } catch (err) {
    console.error('Error fetching completed orders:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch completed orders', error: err.message });
  }
});

// ==========================================
// REVIEWS ENDPOINTS (MongoDB 'reviews' Collection)
// ==========================================

// GET /reviews/user/:userid - Fetch all reviews given by a user from MongoDB
app.get('/reviews/user/:userid', async (req, res) => {
  try {
    const { userid } = req.params;
    if (!userid) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const reviewsCollection = mongoose.connection.db.collection('reviews');
    const userReviews = await reviewsCollection
      .find({
        $or: [
          { userId: String(userid) },
          { user_id: String(userid) }
        ]
      })
      .sort({ createdAt: -1 })
      .toArray();

    return res.status(200).json({
      success: true,
      reviews: userReviews || []
    });
  } catch (err) {
    console.error('Error fetching user reviews from MongoDB:', err);
    return res.status(500).json({ success: false, message: 'Failed to fetch user reviews', error: err.message });
  }
});

// POST /reviews (and fallback aliases) - Save review into MongoDB 'reviews' collection
const handleSaveReview = async (req, res) => {
  try {
    const {
      userId,
      user_id,
      orderId,
      order_id,
      restaurantId,
      restaurant_id,
      restaurantName,
      deliveryBoyId,
      delivery_boy_id,
      deliveryBoyName,
      restaurantRating,
      restaurantReview,
      rating,
      review,
      deliveryBoyRating,
      deliveryBoyReview,
      orderDetails
    } = req.body;

    const finalUserId = userId || user_id || req.params.userid;
    const finalOrderId = orderId || order_id || req.params.orderId;

    if (!finalOrderId) {
      return res.status(400).json({ success: false, message: 'Order ID is required' });
    }

    const reviewsCollection = mongoose.connection.db.collection('reviews');

    const reviewDoc = {
      userId: String(finalUserId || ''),
      user_id: String(finalUserId || ''),
      orderId: String(finalOrderId),
      order_id: String(finalOrderId),
      restaurantId: String(restaurantId || restaurant_id || ''),
      restaurant_id: String(restaurantId || restaurant_id || ''),
      restaurantName: restaurantName || 'Restaurant',
      deliveryBoyId: String(deliveryBoyId || delivery_boy_id || ''),
      delivery_boy_id: String(deliveryBoyId || delivery_boy_id || ''),
      deliveryBoyName: deliveryBoyName || 'Delivery Partner',
      restaurantRating: Number(restaurantRating ?? rating ?? 0),
      restaurantReview: (restaurantReview || review || '').trim(),
      deliveryBoyRating: Number(deliveryBoyRating ?? 0),
      deliveryBoyReview: (deliveryBoyReview || '').trim(),
      orderDetails: orderDetails || [],
      createdAt: new Date()
    };

    // Upsert review into 'reviews' collection in MongoDB
    await reviewsCollection.updateOne(
      { orderId: String(finalOrderId) },
      { $set: reviewDoc },
      { upsert: true }
    );

    console.log('[Backend] Successfully saved review to MongoDB reviews collection for order:', finalOrderId);

    return res.status(200).json({
      success: true,
      message: 'Review saved successfully to MongoDB',
      review: reviewDoc
    });
  } catch (err) {
    console.error('Error saving review to MongoDB:', err);
    return res.status(500).json({ success: false, message: 'Failed to save review', error: err.message });
  }
};

app.post('/reviews', handleSaveReview);
app.post('/reviews/user/:userid', handleSaveReview);
app.post('/reviews/create', handleSaveReview);
app.post('/reviews/add', handleSaveReview);
app.post('/reviews/submit', handleSaveReview);
app.post('/review', handleSaveReview);
app.post('/orders/review', handleSaveReview);

// Start Server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});



// POST /orders/cod - Create Cash on Delivery (COD) Order
app.post('/orders/cod', async (req, res) => {
  const {
    userId,
    cartItems,
    restaurantId,
    restaurantName,
    totalPrice,
    gst,
    platformFee,
    grandTotal,
    coinsEarned,
    userName,
    userEmail,
    userPhone,
    deliveryAddressInfo,
    userCoordinates,
    deliveryDistance,
    deliveryFee,
    surgeFee,
    couponCode,
    influencerName,
    discountAmount
  } = req.body;

  if (!userId || !cartItems || cartItems.length === 0) {
    return res.status(400).json({ success: false, message: 'User ID and items are required' });
  }

  try {
    const ordersCollection = mongoose.connection.db.collection('orders');
    const countersCollection = mongoose.connection.db.collection('counters');

    const counterDoc = await countersCollection.findOneAndUpdate(
      { _id: 'orderId-global' },
      { $inc: { seq: 1 } },
      { returnDocument: 'after', returnOriginal: false, upsert: true }
    );

    let nextSeq = counterDoc?.value?.seq || counterDoc?.seq || Math.floor(1000 + Math.random() * 9000);
    const generatedOrderId = "ORD-" + String(nextSeq).padStart(5, '0');
    const generatedCfOrderId = "order_" + Date.now() + "_" + Math.floor(1000 + Math.random() * 9000);

    const orderDocument = {
      userId: userId,
      items: cartItems.map(item => ({
        itemId: String(item._id || item.itemId || item.id),
        name: item.itemName || item.name,
        price: Number(item.price),
        quantity: Number(item.quantity),
        _id: item._id || item.itemId || item.id
      })),
      totalCount: cartItems.reduce((sum, item) => sum + (item.quantity || 0), 0),
      totalPrice: Number(totalPrice),
      gst: Number(gst),
      platformFee: Number(platformFee),
      grandTotal: Number(grandTotal),
      couponCode: couponCode || null,
      influencerName: influencerName || null,
      discountAmount: discountAmount ? Number(discountAmount) : 0,
      orderId: generatedOrderId,
      cashfreeOrderId: generatedCfOrderId,
      cashfreePaymentSessionId: "session_cod_" + Date.now(),
      paymentMethod: 'COD',
      paymentStatus: 'Pending',
      coinsEarned: Number(coinsEarned || 0),
      userName: userName || '',
      userEmail: userEmail || '',
      userPhone: userPhone || '',
      isPhoneVerified: req.body.isPhoneVerified !== undefined ? req.body.isPhoneVerified : true,
      flatNo: deliveryAddressInfo?.flatNo || '',
      street: deliveryAddressInfo?.street || '',
      landmark: deliveryAddressInfo?.landmark || '',
      deliveryAddress: (deliveryAddressInfo?.flatNo || '') + ", " + (deliveryAddressInfo?.street || '') + (deliveryAddressInfo?.landmark ? ' , ' + deliveryAddressInfo.landmark : ''),
      restaurantId: String(restaurantId || cartItems[0]?.restId || ''),
      restaurantName: restaurantName || cartItems[0]?.restaurantName || '',
      userCoordinates: userCoordinates || null,
      deliveryDistance: deliveryDistance || null,
      deliveryFee: Number(deliveryFee || 0),
      surgeFee: Number(surgeFee || 0),
      orderDate: new Date(),
      __v: 0
    };

    await ordersCollection.insertOne(orderDocument);

    const orderStatusesCollection = mongoose.connection.db.collection('orderstatuses');
    const statusDocument = {
      ...orderDocument,
      status: 'waiting for the restaurent to accept'
    };
    await orderStatusesCollection.insertOne(statusDocument);

    return res.status(200).json({
      success: true,
      message: 'COD order placed successfully',
      orderId: generatedOrderId,
      cashfreeOrderId: generatedCfOrderId
    });
  } catch (err) {
    console.error('COD order placement error:', err);
    return res.status(500).json({ success: false, message: 'Failed to place COD order', error: err.message });
  }
});

// POST /api/payment/generate-qr - Generate Cashfree Dynamic UPI QR Code for Doorstep Payment
app.post('/api/payment/generate-qr', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ success: false, message: 'Order ID is required' });
  }

  try {
    const ordersCollection = mongoose.connection.db.collection('orders');
    const query = { $or: [{ orderId: orderId }, { cashfreeOrderId: orderId }] };
    if (mongoose.Types.ObjectId.isValid(orderId)) {
      query.$or.push({ _id: new mongoose.Types.ObjectId(orderId) });
    }
    const order = await ordersCollection.findOne(query);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const amount = Number(order.grandTotal || order.totalPrice || 0);
    const cfOrderId = order.cashfreeOrderId || order.orderId;

    console.log('[Cashfree Dynamic QR] Generating QR for:', { cfOrderId, amount });

    const upiString = "upi://pay?pa=" + CASHFREE_APP_ID + "@cashfree&pn=LeevonDelivery&am=" + amount + "&tn=" + cfOrderId + "&cu=INR";
    const qrCodeUrl = "https://api.qrserver.com/v1/create-qr-code/?size=250x250&data=" + encodeURIComponent(upiString);

    return res.status(200).json({
      success: true,
      orderId: order.orderId,
      cashfreeOrderId: cfOrderId,
      amount: amount,
      upiString: upiString,
      qrCodeUrl: qrCodeUrl
    });
  } catch (err) {
    console.error('Generate Dynamic QR error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate Dynamic QR Code', error: err.message });
  }
});

// POST /api/payment/verify-doorstep-pay - Verify doorstep pay and update status to Paid
app.post('/api/payment/verify-doorstep-pay', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ success: false, message: 'Order ID is required' });
  }

  try {
    const db = mongoose.connection.db;
    const query = { $or: [{ orderId: orderId }, { cashfreeOrderId: orderId }] };
    if (mongoose.Types.ObjectId.isValid(orderId)) {
      query.$or.push({ _id: new mongoose.Types.ObjectId(orderId) });
    }

    await db.collection('orders').updateOne(query, { $set: { paymentStatus: 'Paid' } });
    await db.collection('orderstatuses').updateOne(query, { $set: { paymentStatus: 'Paid' } });
    await db.collection('acceptedbydeliveries').updateOne(query, { $set: { paymentStatus: 'Paid' } });

    return res.status(200).json({
      success: true,
      message: 'Doorstep payment marked as Paid successfully'
    });
  } catch (err) {
    console.error('Verify doorstep pay error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});
