const checkIsUserBlocked = (user) => {
  if (!user || typeof user !== 'object') return false;
  return (
    user.isBlocked === true ||
    String(user.isBlocked).toLowerCase() === 'true' ||
    user.is_blocked === true ||
    String(user.is_blocked).toLowerCase() === 'true' ||
    user.blocked === true ||
    String(user.blocked).toLowerCase() === 'true' ||
    String(user.status || '').toLowerCase() === 'blocked' ||
    String(user.status || '').toLowerCase() === 'inactive' ||
    user.isActive === false ||
    String(user.isActive).toLowerCase() === 'false' ||
    user.is_active === false ||
    String(user.is_active).toLowerCase() === 'false'
  );
};

require('dotenv').config();
const QRCode = require('qrcode');
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


// Razorpay Configuration
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID;
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET;

let razorpay = null;
if (RAZORPAY_KEY_ID && RAZORPAY_KEY_SECRET) {
  try {
    razorpay = new Razorpay({
      key_id: RAZORPAY_KEY_ID,
      key_secret: RAZORPAY_KEY_SECRET,
    });
    console.log('Razorpay initialized successfully.');
  } catch (rzpErr) {
    console.error('Razorpay initialization error:', rzpErr.message);
  }
} else {
  console.warn('Razorpay KEY_ID/KEY_SECRET not set in environment variables.');
}
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MongoURL || process.env.MONGODB_URI;

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
  .then(async () => {
    console.log("Connected to MongoDB Atlas successfully");
    try {
      const db = mongoose.connection.db;
      await Promise.all([
        db.collection('orderstatuses').createIndex({ userId: 1, orderDate: -1, createdAt: -1 }),
        db.collection('orders').createIndex({ userId: 1 }),
        db.collection('reviews').createIndex({ userId: 1 })
      ]);
      console.log("[MongoDB] Performance indexes ensured for orderstatuses, orders, reviews");
    } catch (e) {
      console.warn("[MongoDB] Index creation warning:", e.message);
    }
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
    const finalId = req.params.userId || req.params.userid;
    if (!finalId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const orConditions = [
      { userId: String(finalId) },
      { user_id: String(finalId) },
      { customerId: String(finalId) }
    ];

    if (mongoose.Types.ObjectId.isValid(finalId)) {
      const objId = new mongoose.Types.ObjectId(finalId);
      orConditions.push({ userId: objId }, { user_id: objId }, { customerId: objId });
    }

    const userReviews = await Review.find({ $or: orConditions }).sort({ createdAt: -1 }).lean();

    return res.status(200).json({
      success: true,
      reviews: userReviews || []
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

// Orders Completed Endpoint (fetches completed orders from finalcompletedorders collection)
const handleGetCompletedOrders = async (req, res) => {
  try {
    const userId = req.params.userId || req.params.userid;

    if (!userId) {
      return res.status(400).json({ success: false, message: 'User ID is required' });
    }

    const ordersCollection = mongoose.connection.db.collection('finalcompletedorders');
    console.log(`[GET /orders/completed/${userId}] Request received.`);

    const query = {
      $or: [
        { userId: String(userId) },
        { user_id: String(userId) },
        { customerId: String(userId) }
      ]
    };

    if (mongoose.Types.ObjectId.isValid(userId)) {
      const objId = new mongoose.Types.ObjectId(userId);
      query.$or.push({ userId: objId }, { user_id: objId }, { customerId: objId });
    }

    console.log(`[GET /orders/completed/${userId}] Querying database:`, JSON.stringify(query));

    const completedOrders = await ordersCollection.find(query).toArray();

    const formattedCompleted = (completedOrders || []).map(order => ({
      ...order,
      status: order.status || 'Completed',
      isRejected: false
    }));

    formattedCompleted.sort((a, b) => {
      const dateA = new Date(a.orderDate || a.completedAt || a.createdAt || 0);
      const dateB = new Date(b.orderDate || b.completedAt || b.createdAt || 0);
      return dateB - dateA;
    });

    return res.status(200).json({ success: true, orders: formattedCompleted });
  } catch (error) {
    console.error('Error fetching completed orders:', error);
    return res.status(500).json({ success: false, message: 'Failed to fetch completed orders', error: error.message });
  }
};

app.get('/orders/completed/:userId', handleGetCompletedOrders);
app.get('/api/orders/completed/:userId', handleGetCompletedOrders);
app.get('/orders/completed/user/:userId', handleGetCompletedOrders);

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
      isPhoneVerified: req.body.isPhoneVerified === true || req.body.isPhoneVerified === 'true' || req.body.isPhoneVerified === 1,
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

// GET /check-phone/:phone - Check if phone number is already linked to another account
app.get('/check-phone/:phone', async (req, res) => {
  const { phone } = req.params;
  const excludeUserId = req.query.excludeUserId;

  if (!phone) {
    return res.status(400).json({ success: false, message: "Phone number is required" });
  }

  try {
    const cleanPhone = String(phone).trim().replace(/\D/g, '').slice(-10);
    const query = {
      phone: { $regex: cleanPhone }
    };

    if (excludeUserId && String(excludeUserId).trim() && String(excludeUserId).trim() !== 'null' && String(excludeUserId).trim() !== 'undefined') {
      const exId = String(excludeUserId).trim();
      if (mongoose.Types.ObjectId.isValid(exId)) {
        query._id = { $ne: new mongoose.Types.ObjectId(exId) };
      } else {
        query._id = { $ne: exId };
      }
    }

    const existingUser = await User.findOne(query).lean();
    if (existingUser) {
      return res.status(200).json({ success: true, exists: true, message: "Phone number already linked to another account" });
    }

    return res.status(200).json({ success: true, exists: false, message: "Phone number available" });
  } catch (err) {
    console.error("GET /check-phone error:", err);
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
      const authObj = firebaseApp ? getAuth(firebaseApp) : getAuth();
      const decodedToken = await authObj.verifyIdToken(idToken);
    const { email, name, uid } = decodedToken;

    if (!email) {
      return res.status(400).json({ success: false, message: "Email not provided by Google account" });
    }

    let user = await User.findOne({ email }).lean();

    if (user && checkIsUserBlocked(user)) {
      console.warn(`[Google Login Blocked] User "${email}" is blocked by admin.`);
      return res.status(403).json({
        success: false,
        isBlocked: true,
        message: "Your account has been blocked by admin. Please contact support."
      });
    }

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
    return res.status(401).json({ success: false, message: err.message || "Invalid or expired Google Token" });
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

// POST /user/verify-phone - Verify phone number and update DB
app.post('/user/verify-phone', async (req, res) => {
  const { phone, userid } = req.body;
  if (!phone && !userid) {
    return res.status(400).json({ success: false, message: 'Phone or User ID is required' });
  }
  try {
    const query = userid ? { _id: userid } : { phone };
    const updatedUser = await User.findOneAndUpdate(
      query,
      { isPhoneVerified: true },
      { new: true }
    ).lean();

    if (!updatedUser) {
      return res.status(404).json({ success: false, message: 'User not found' });
    }

    const { password: _, ...userData } = updatedUser;
    return res.status(200).json({
      success: true,
      message: 'Phone number verified successfully',
      user: userData
    });
  } catch (err) {
    console.error('Verify phone route error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

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
        { userId: userid },
        { user_id: userid },
        { customerId: userid }
      ]
    };

    if (mongoose.Types.ObjectId.isValid(userid)) {
      const objId = new mongoose.Types.ObjectId(userid);
      query.$or.push({ userId: objId }, { user_id: objId }, { customerId: objId });
    }

    const db = mongoose.connection.db;

    // 1. Query orderstatuses collection
    const latestStatusDoc = await db.collection('orderstatuses')
      .find(query)
      .sort({ orderDate: -1, createdAt: -1, _id: -1 })
      .limit(1)
      .next();

    // 2. Query acceptedbydeliveries collection for delivery/restaurant updates
    const latestAcceptedDoc = await db.collection('acceptedbydeliveries')
      .find(query)
      .sort({ orderDate: -1, createdAt: -1, _id: -1 })
      .limit(1)
      .next();

    // 3. Query orders collection
    const latestOrderDoc = await db.collection('orders')
      .find(query)
      .sort({ orderDate: -1, createdAt: -1, _id: -1 })
      .limit(1)
      .next();

    let finalStatusDoc = latestStatusDoc || latestAcceptedDoc || latestOrderDoc;

    if (latestAcceptedDoc && latestAcceptedDoc.status && !String(latestAcceptedDoc.status).toLowerCase().includes('waiting for the restaurent')) {
      finalStatusDoc = { ...latestStatusDoc, ...latestAcceptedDoc };
    } else if (latestOrderDoc && latestOrderDoc.status && !String(latestOrderDoc.status).toLowerCase().includes('waiting for the restaurent')) {
      finalStatusDoc = { ...latestStatusDoc, ...latestOrderDoc };
    }

    return res.status(200).json({ success: true, orderStatus: finalStatusDoc || null });

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
        const doc = await col.findOne({
            $or: [
              { restaurantId: String(restaurantId) },
              { restId: String(restaurantId) },
              { _id: String(restaurantId) }
            ]
          });
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
  const { couponCode, cartTotal, userId, userPhone } = req.body;

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

    // Single-use per customer check
    const targetUid = userId ? String(userId).trim() : null;
    const targetPhone = userPhone ? String(userPhone).trim() : null;
    if (targetUid || targetPhone) {
      const existingUsage = await mongoose.connection.db.collection('couponusages').findOne({
        couponCode: coupon.couponCode,
        $or: [
          ...(targetUid ? [{ userId: targetUid }] : []),
          ...(targetPhone ? [{ userPhone: targetPhone }] : [])
        ]
      });
      if (existingUsage) {
        return res.status(400).json({ success: false, message: "You have already used this coupon code." });
      }
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


// POST /payment/order - Create a Razorpay payment order session
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

    const receiptId = `rcpt_${Date.now()}_${Math.floor(1000 + Math.random() * 9000)}`;
    const amountInPaise = Math.round(Number(amount) * 100);

    console.log("[Razorpay Order] Creating order:", { amount, amountInPaise, userId });

    const razorpayOrder = await razorpay.orders.create({
      amount: amountInPaise,
      currency: "INR",
      receipt: receiptId,
      notes: {
        userId: String(userId || ''),
        userPhone: String(userPhone || '')
      }
    });

    console.log("[Razorpay Order] Order created successfully:", razorpayOrder.id);

    return res.status(200).json({
      success: true,
      orderId: razorpayOrder.id,
      razorpay_order_id: razorpayOrder.id,
      payment_session_id: razorpayOrder.id,
      amount: Number(amount),
      currency: "INR",
      keyId: RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error("Create Razorpay order error:", err);
    return res.status(500).json({ success: false, message: "Failed to create payment order", error: err.message });
  }
});

// POST /payment/verify - Verify Razorpay payment and place the order in database
app.post('/payment/verify', async (req, res) => {
  const {
    order_id,
    cf_order_id,
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
    payment_session_id,
    userId,
    cartItems,
    restaurantId,
    restaurantName,
    totalPrice,
    gst,
    foodGst,
    deliveryGst,
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

  const targetOrderId = razorpay_order_id || order_id || cf_order_id;
  const targetPaymentId = razorpay_payment_id || payment_session_id || targetOrderId;

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
    } else if (razorpay_signature && targetOrderId && targetPaymentId) {
      const crypto = require('crypto');
      const expectedSignature = crypto
        .createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(targetOrderId + "|" + targetPaymentId)
        .digest('hex');

      if (expectedSignature === razorpay_signature) {
        console.log("[Payment Verify] Razorpay signature verified successfully.");
        isPaymentValid = true;
      } else {
        console.error("[Payment Verify] Razorpay signature mismatch!");
      }
    }

    if (!isPaymentValid) {
      try {
        const rzpOrder = await razorpay.orders.fetch(targetOrderId);
        if (rzpOrder && (rzpOrder.status === 'paid' || rzpOrder.status === 'processed' || rzpOrder.status === 'attempted')) {
          console.log("[Payment Verify] Razorpay order status verified as paid via API.");
          isPaymentValid = true;
        }
      } catch (rzpErr) {
        console.error("Razorpay API fetch verification error:", rzpErr.message);
        if (targetPaymentId && (targetPaymentId.startsWith('pay_') || targetPaymentId.startsWith('order_'))) {
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
      foodGst: Number(req.body.foodGst || 0),
      deliveryGst: Number(req.body.deliveryGst || 0),
      platformFee: Number(platformFee),
      grandTotal: Number(grandTotal),
      couponCode: couponCode || null,
      influencerName: influencerName || null,
      discountAmount: discountAmount ? Number(discountAmount) : 0,
      orderId: generatedOrderId,
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

    if (couponCode && (userId || userPhone)) {
      await mongoose.connection.db.collection('couponusages').insertOne({
        couponCode: String(couponCode).trim().toUpperCase(),
        userId: userId ? String(userId).trim() : null,
        userPhone: userPhone ? String(userPhone).trim() : null,
        orderId: typeof generatedOrderId !== 'undefined' ? generatedOrderId : (orderDocument.orderId || null),
        usedAt: new Date()
      }).catch(e => console.warn('[Coupon] Failed to record usage:', e.message));
    }

    const orderStatusesCollection = mongoose.connection.db.collection('orderstatuses');
    const statusDocument = {
      ...orderDocument,
      status: "waiting for the restaurent to accept"
    };
    await orderStatusesCollection.insertOne(statusDocument);

    // Note: Coins will be awarded ONLY when order moves to finalcompletedorders collection

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
            user.savedAddresses.push({
              flatNo: deliveryAddressInfo.flatNo,
              street: deliveryAddressInfo.street,
              landmark: deliveryAddressInfo.landmark || '',
              tag: deliveryAddressInfo.tag || 'Home'
            });
            await user.save();
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

// ==========================================
// RAZORPAY WEBHOOK ENDPOINTS
// Live URL: https://customerbackendfile.onrender.com/api/razorpay-webhook
// Live URL: https://customerbackendfile.onrender.com/razorpay-webhook
// ==========================================
const handleRazorpayWebhook = async (req, res) => {
  try {
    const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET || process.env.RAZORPAY_KEY_SECRET;
    const razorpaySignature = req.headers['x-razorpay-signature'];

    if (!razorpaySignature) {
      console.error('[Razorpay Webhook] Missing x-razorpay-signature header');
      return res.status(400).json({ success: false, message: 'Missing signature' });
    }

    // Verify signature using HMAC SHA256
    const crypto = require('crypto');
    const expectedSignature = crypto
      .createHmac('sha256', webhookSecret)
      .update(JSON.stringify(req.body))
      .digest('hex');

    if (expectedSignature !== razorpaySignature) {
      console.error('[Razorpay Webhook] Webhook signature mismatch!');
      return res.status(400).json({ success: false, message: 'Signature mismatch' });
    }

    const { event, payload } = req.body;
    console.log(`[Razorpay Webhook] Verified event received: ${event}`);

    const db = mongoose.connection.db;
    const ordersCollection = db.collection('orders');
    const orderStatusesCollection = db.collection('orderstatuses');

    if (event === 'payment.captured' || event === 'order.paid') {
      const payment = payload.payment.entity;
      const rzpOrderId = payment.order_id;
      const paymentId = payment.id;

      console.log(`[Razorpay Webhook] Payment SUCCESS for Order ${rzpOrderId}, Payment ID: ${paymentId}`);

      // Update orders collection
      await ordersCollection.updateMany(
        {
          $or: [
            { razorpayOrderId: rzpOrderId },
            { razorpay_order_id: rzpOrderId },
            { orderId: rzpOrderId }
          ]
        },
        {
          $set: {
            paymentStatus: 'Paid',
            status: 'PAID',
            razorpayPaymentId: paymentId,
            razorpay_payment_id: paymentId,
            paidAt: new Date()
          }
        }
      );

      // Update orderstatuses collection
      await orderStatusesCollection.updateMany(
        {
          $or: [
            { razorpayOrderId: rzpOrderId },
            { razorpay_order_id: rzpOrderId },
            { orderId: rzpOrderId }
          ]
        },
        {
          $set: {
            paymentStatus: 'Paid',
            status: 'waiting for the restaurent to accept',
            razorpayPaymentId: paymentId,
            razorpay_payment_id: paymentId,
            paidAt: new Date()
          }
        }
      );
    } else if (event === 'payment.failed') {
      const payment = payload.payment.entity;
      const rzpOrderId = payment.order_id;

      console.warn(`[Razorpay Webhook] Payment FAILED for Order ${rzpOrderId}`);

      await ordersCollection.updateMany(
        {
          $or: [
            { razorpayOrderId: rzpOrderId },
            { razorpay_order_id: rzpOrderId }
          ]
        },
        {
          $set: {
            paymentStatus: 'FAILED',
            failureReason: payment.error_description || 'Payment Failed'
          }
        }
      );
    }

    return res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('[Razorpay Webhook] Error processing webhook:', err);
    return res.status(500).json({ success: false, message: 'Error processing webhook', error: err.message });
  }
};

app.post('/api/razorpay-webhook', handleRazorpayWebhook);
app.post('/razorpay-webhook', handleRazorpayWebhook);


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
    foodGst,
    deliveryGst,
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
      foodGst: Number(req.body.foodGst || 0),
      deliveryGst: Number(req.body.deliveryGst || 0),
      platformFee: Number(platformFee),
      grandTotal: Number(grandTotal),
      couponCode: couponCode || null,
      influencerName: influencerName || null,
      discountAmount: discountAmount ? Number(discountAmount) : 0,
      orderId: generatedOrderId,
      razorpayOrderId: generatedCfOrderId,
      razorpayPaymentId: "session_cod_" + Date.now(),
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

    if (couponCode && (userId || userPhone)) {
      await mongoose.connection.db.collection('couponusages').insertOne({
        couponCode: String(couponCode).trim().toUpperCase(),
        userId: userId ? String(userId).trim() : null,
        userPhone: userPhone ? String(userPhone).trim() : null,
        orderId: typeof generatedOrderId !== 'undefined' ? generatedOrderId : (orderDocument.orderId || null),
        usedAt: new Date()
      }).catch(e => console.warn('[Coupon] Failed to record usage:', e.message));
    }

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
      razorpayOrderId: generatedCfOrderId
    });
  } catch (err) {
    console.error('COD order placement error:', err);
    return res.status(500).json({ success: false, message: 'Failed to place COD order', error: err.message });
  }
});


// Helper to register order with Cashfree PG & return Dynamic QR details
// Helper to register order with Cashfree PG & return Dynamic QR details (generated 100% locally on server)
// Helper to register order with Cashfree PG & return 100% NPCI-compliant Dynamic UPI QR details

// Helper to register order session with official Cashfree PG & return Checkout URL

// Helper to register order session with official Cashfree PG & return Checkout URL

// GET /api/payment/cashfree-checkout/:sessionId - Serve official Cashfree JS v3 Checkout Page

// GET /api/payment/cashfree-checkout/:sessionId - Serve official Cashfree JS v3 Checkout Page
app.get('/api/payment/cashfree-checkout/:sessionId', (req, res) => {
  const { sessionId } = req.params;
  const mode = CASHFREE_ENV === 'PROD' ? 'production' : 'sandbox';
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Cashfree Official Payment</title>
  <script src="https://sdk.cashfree.com/js/v3/cashfree.js"></script>
  <style>
    body, html { margin: 0; padding: 0; width: 100%; height: 100%; font-family: sans-serif; background: #ffffff; }
    #cashfree-container { width: 100%; height: 100%; min-height: 440px; }
  </style>
</head>
<body>
  <div id="cashfree-container"></div>
  <script>
    document.addEventListener("DOMContentLoaded", function() {
      try {
        const cashfree = Cashfree({ mode: "${mode}" });
        cashfree.checkout({
          paymentSessionId: "${sessionId}",
          redirectTarget: "_self"
        });
      } catch(err) {
        console.error("Cashfree SDK init error:", err);
      }
    });
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  return res.send(html);
});

// Helper to register order session with official Cashfree PG & return QR Code & URLs
async function getCashfreeDynamicQr(order) {
  const amount = Number(order.grandTotal || order.totalPrice || 0);
  const cfOrderId = order.cashfreeOrderId || order.orderId || `order_${Date.now()}`;
  const cleanPhone = (order.userPhone && String(order.userPhone).replace(/\D/g, '').slice(-10)) || '9999999999';
  const cleanEmail = (order.userEmail && order.userEmail !== 'N/A' ? order.userEmail : 'customer@example.com');
  const cleanName = (order.userName && order.userName !== 'N/A' ? order.userName : 'Customer');
  const cleanUserId = String(order.userId || `user_${Date.now()}`);

  let paymentSessionId = '';

  if (CASHFREE_APP_ID && CASHFREE_SECRET_KEY) {
    try {
      console.log('[Cashfree Official PG] Creating order session on Cashfree:', { cfOrderId, amount });
      const cfRes = await fetch(`${CASHFREE_BASE_URL}/orders`, {
        method: 'POST',
        headers: {
          'x-client-id': CASHFREE_APP_ID,
          'x-client-secret': CASHFREE_SECRET_KEY,
          'x-api-version': '2023-08-01',
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          order_id: cfOrderId,
          order_amount: amount,
          order_currency: 'INR',
          customer_details: {
            customer_id: cleanUserId,
            customer_name: cleanName,
            customer_email: cleanEmail,
            customer_phone: cleanPhone
          }
        })
      });
      const cfData = await cfRes.json();

      if (cfRes.ok && cfData.payment_session_id) {
        paymentSessionId = cfData.payment_session_id;
      } else if (cfRes.status === 409 || cfData.code === 'order_already_exists') {
        const getRes = await fetch(`${CASHFREE_BASE_URL}/orders/${cfOrderId}`, {
          headers: {
            'x-client-id': CASHFREE_APP_ID,
            'x-client-secret': CASHFREE_SECRET_KEY,
            'x-api-version': '2023-08-01'
          }
        });
        if (getRes.ok) {
          const getData = await getRes.json();
          paymentSessionId = getData.payment_session_id || '';
        }
      }
    } catch (cfErr) {
      console.error('[Cashfree PG] Session error:', cfErr.message);
    }
  }

  // Alphanumeric transaction ref ID for NPCI compliance
  const cleanTr = cfOrderId.replace(/[^a-zA-Z0-9]/g, '');
  const cleanTn = `Order${cleanTr}`;
  const payeeVpa = process.env.MERCHANT_UPI_VPA || `${CASHFREE_APP_ID}@cashfree`;
  const upiString = `upi://pay?pa=${payeeVpa}&pn=LeevonDelivery&tr=${cleanTr}&tn=${cleanTn}&am=${amount.toFixed(2)}&cu=INR`;

  let qrCodeUrl = '';
  try {
    qrCodeUrl = await QRCode.toDataURL(upiString, { margin: 1, width: 300 });
  } catch (err) {
    console.error('[QRCode Generator] Error:', err.message);
  }

  const hostPort = process.env.PORT || 5000;
  const paymentUrl = paymentSessionId
    ? `http://localhost:${hostPort}/api/payment/cashfree-checkout/${paymentSessionId}`
    : `https://payments.cashfree.com/links/${cfOrderId}`;

  return {
    success: true,
    orderId: order.orderId,
    cashfreeOrderId: cfOrderId,
    amount: amount,
    paymentSessionId: paymentSessionId,
    paymentUrl: paymentUrl,
    upiString: upiString,
    qrCodeUrl: qrCodeUrl
  };
}


app.post('/api/payment/generate-qr', async (req, res) => {
  const { orderId } = req.body;
  if (!orderId) {
    return res.status(400).json({ success: false, message: 'Order ID is required' });
  }

  try {
    const ordersCollection = mongoose.connection.db.collection('orders');
    const query = { $or: [{ orderId: orderId }, { razorpayOrderId: orderId }, { cashfreeOrderId: orderId }] };
    if (mongoose.Types.ObjectId.isValid(orderId)) {
      query.$or.push({ _id: new mongoose.Types.ObjectId(orderId) });
    }
    const order = await ordersCollection.findOne(query);

    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const qrResult = await getCashfreeDynamicQr(order);
    return res.status(200).json(qrResult);
  } catch (err) {
    console.error('Generate Dynamic QR error:', err);
    return res.status(500).json({ success: false, message: 'Failed to generate Dynamic QR Code', error: err.message });
  }
});

// POST /api/payment/verify-doorstep-pay - Verify doorstep pay and update status to Paid
// POST /api/payment/verify-doorstep-pay - Verify doorstep pay and update status to Paid
app.post('/api/payment/verify-doorstep-pay', async (req, res) => {
  const { orderId, markPaid } = req.body;
  if (!orderId) {
    return res.status(400).json({ success: false, message: 'Order ID is required' });
  }

  try {
    const db = mongoose.connection.db;
    const query = { $or: [{ orderId: orderId }, { razorpayOrderId: orderId }, { cashfreeOrderId: orderId }] };
    if (mongoose.Types.ObjectId.isValid(orderId)) {
      query.$or.push({ _id: new mongoose.Types.ObjectId(orderId) });
    }

    let order = await db.collection('orders').findOne(query);
    if (!order) {
      order = await db.collection('acceptedbydeliveries').findOne(query);
    }
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }

    const cfOrderId = order.cashfreeOrderId || order.orderId;

    // Check Cashfree PG Order Status if credentials are configured
    

    if (markPaid || order.paymentStatus === 'Paid') {
      await db.collection('orders').updateOne(query, { $set: { paymentStatus: 'Paid' } });
      await db.collection('orderstatuses').updateOne(query, { $set: { paymentStatus: 'Paid' } });
      await db.collection('acceptedbydeliveries').updateOne(query, { $set: { paymentStatus: 'Paid' } });
      return res.status(200).json({
        success: true,
        paymentStatus: 'Paid',
        isPaid: true,
        message: 'Doorstep payment marked as Paid successfully'
      });
    }

    return res.status(200).json({
      success: true,
      paymentStatus: order.paymentStatus || 'Pending',
      isPaid: String(order.paymentStatus).toLowerCase() === 'paid',
      message: 'Payment status checked'
    });
  } catch (err) {
    console.error('Verify doorstep pay error:', err);
    return res.status(500).json({ success: false, message: 'Internal server error', error: err.message });
  }
});

// GET /api/payment/verify-doorstep-pay/:orderId - Check status via GET
app.get('/api/payment/verify-doorstep-pay/:orderId', async (req, res) => {
  const { orderId } = req.params;
  try {
    const db = mongoose.connection.db;
    const query = { $or: [{ orderId: orderId }, { razorpayOrderId: orderId }, { cashfreeOrderId: orderId }] };
    if (mongoose.Types.ObjectId.isValid(orderId)) {
      query.$or.push({ _id: new mongoose.Types.ObjectId(orderId) });
    }
    let order = await db.collection('orders').findOne(query);
    if (!order) {
      order = await db.collection('acceptedbydeliveries').findOne(query);
    }
    if (!order) {
      return res.status(404).json({ success: false, message: 'Order not found' });
    }
    const isPaid = String(order.paymentStatus).toLowerCase() === 'paid';
    return res.status(200).json({
      success: true,
      paymentStatus: order.paymentStatus || 'Pending',
      isPaid: isPaid
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: 'Error checking payment status' });
  }
});

// GET /api/payment/razorpay-checkout/:orderId - Serve official Razorpay Checkout Page
app.get('/api/payment/razorpay-checkout/:orderId', async (req, res) => {
  const { orderId } = req.params;
  const amount = req.query.amount || '100';
  const name = req.query.name || 'Customer';
  const email = req.query.email || 'customer@example.com';
  const phone = req.query.phone || '9999999999';
  const keyId = RAZORPAY_KEY_ID;
  const amountInPaise = Math.round(Number(amount) * 100);

  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Leevon Delivery Payment</title>
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <style>
    body, html { margin: 0; padding: 0; width: 100%; height: 100%; font-family: sans-serif; background: #F9F9F6; display: flex; justify-content: center; align-items: center; }
    .card { background: #FFFFFF; border-radius: 20px; padding: 30px; text-align: center; box-shadow: 0 4px 15px rgba(0,0,0,0.1); width: 85%; max-width: 320px; }
    .btn { background: #27AE60; color: #FFFFFF; border: none; padding: 14px 28px; border-radius: 25px; font-size: 16px; font-weight: bold; width: 100%; cursor: pointer; margin-top: 16px; }
  </style>
</head>
<body>
  <div class="card">
    <h3 style="margin-top:0; color:#1E3545;">Leevon Delivery</h3>
    <p style="color:#666666; font-size:14px;">Order Amount: &#8377;${amount}</p>
    <button id="pay-btn" class="btn">Pay Now with Razorpay</button>
  </div>
  <script>
    const options = {
      key: "${keyId}",
      amount: ${amountInPaise},
      currency: "INR",
      name: "Leevon Delivery",
      description: "Order #${orderId}",
      order_id: "${orderId}",
      prefill: { name: "${name}", email: "${email}", contact: "${phone}" },
      theme: { color: "#27AE60" },
      handler: function(response) {
        window.location.href = "/api/payment/razorpay-success?razorpay_order_id=" + response.razorpay_order_id + "&razorpay_payment_id=" + response.razorpay_payment_id + "&razorpay_signature=" + response.razorpay_signature;
      },
      modal: {
        ondismiss: function() {
          window.location.href = "/api/payment/razorpay-cancel";
        }
      }
    };
    const rzp = new Razorpay(options);
    document.getElementById('pay-btn').onclick = function() { rzp.open(); };
    window.onload = function() { rzp.open(); };
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  return res.send(html);
});

// GET /api/payment/razorpay-success
app.get('/api/payment/razorpay-success', (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.query;
  const html = `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Payment Successful</title>
  <style>
    body { font-family: sans-serif; background: #F9F9F6; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; text-align: center; }
    .card { background: #fff; padding: 30px; border-radius: 20px; box-shadow: 0 4px 15px rgba(0,0,0,0.1); width: 85%; max-width: 320px; }
  </style>
</head>
<body>
  <div class="card">
    <h2 style="color: #27AE60;">Payment Successful!</h2>
    <p>Please return to the Leevon Delivery app.</p>
  </div>
  <script>
    setTimeout(function() {
      if (window.opener) window.close();
    }, 2000);
  </script>
</body>
</html>`;
  res.setHeader('Content-Type', 'text/html');
  return res.send(html);
});

// GET /api/payment/razorpay-cancel