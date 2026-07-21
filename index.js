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

// Initialize Firebase Admin SDK
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

// Initialize Razorpay with fallback test keys
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_T96hBRy748HTkq';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || process.env.RAZORPAY_SECRET_KEY || 'RIFn7bKzOafpJKOLCd0OMU1k';

const razorpay = new Razorpay({
  key_id: RAZORPAY_KEY_ID,
  key_secret: RAZORPAY_KEY_SECRET,
});
const PORT = process.env.PORT || 5000;
const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://omnia771148_db_user:Nk1wTwqHMKCzqti7@cluster0.nbhpjuy.mongodb.net/?appName=Cluster0";

app.use(cors());
app.use(express.json());

// Ensure MongoDB is connected before handling requests
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
  deliveryFeePerKm: { type: Number, default: 10 },
  surgeFee: { type: Number, default: 0 },
  isSurgeActive: { type: Boolean, default: false }
}, { strict: false });

const FeesConfig = mongoose.model('FeesConfig', feesConfigSchema, 'feesconfigs');

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

// Check Phone Uniqueness Endpoint
app.get('/check-phone/:phone', async (req, res) => {
  try {
    const { phone } = req.params;
    const { excludeUserId } = req.query;
    const user = await User.findOne({ phone }).lean();
    if (user) {
      if (excludeUserId && String(user._id) === String(excludeUserId)) {
        return res.status(200).json({ success: true, exists: false });
      }
      return res.status(200).json({ success: true, exists: true });
    }
    return res.status(200).json({ success: true, exists: false });
  } catch (err) {
    console.error("Check phone error:", err);
    return res.status(500).json({ success: false, message: "Internal server error" });
  }
});

// Signup Endpoint
app.post('/signup', async (req, res) => {
  const { phone, password, name, securityAnswer } = req.body;

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
      email: 'N/A',
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
  closeTime: { type: String }
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
const CACHE_DURATION_MS = 10000; // 10 seconds cache duration

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


// POST /payment/order - Create a Razorpay payment order
app.post('/payment/order', async (req, res) => {
  const { amount, userId } = req.body;
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
    const options = {
      amount: Math.round(amount * 100), // amount in paise
      currency: "INR",
      receipt: `rcpt_${Date.now()}_${String(userId || 'anon').slice(-6)}`,
    };
    const order = await razorpay.orders.create(options);
    return res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: RAZORPAY_KEY_ID
    });
  } catch (err) {
    console.error("Create Razorpay order error:", err);
    return res.status(500).json({ success: false, message: "Failed to create payment order", error: err.message });
  }
});

// POST /payment/verify - Verify signature and place the order in database
app.post('/payment/verify', async (req, res) => {
  const {
    razorpay_order_id,
    razorpay_payment_id,
    razorpay_signature,
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

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    console.warn("[Payment Verify] Missing credentials in request body:", {
      has_order_id: !!razorpay_order_id,
      has_payment_id: !!razorpay_payment_id,
      has_signature: !!razorpay_signature
    });
    return res.status(400).json({ success: false, message: "Payment credentials are required" });
  }

  try {
    console.log("[Payment Verify] Verifying payment signature for:", {
      razorpay_order_id,
      razorpay_payment_id,
      userId
    });

    let isSignatureValid = false;

    // Check for simulated/mock payment to allow testing in Expo Go
    if (razorpay_payment_id.startsWith('pay_mock_') && razorpay_signature.startsWith('sig_mock_')) {
      console.log("[Payment Verify] Mock payment detected. Bypassing signature verification.");
      isSignatureValid = true;
    } else {
      const crypto = require('crypto');
      const generated_signature = crypto
        .createHmac('sha256', RAZORPAY_KEY_SECRET)
        .update(razorpay_order_id + "|" + razorpay_payment_id)
        .digest('hex');

      isSignatureValid = (generated_signature === razorpay_signature);

      if (!isSignatureValid) {
        console.error("[Payment Verify] Signature verification failed!");
        console.error("- Generated Signature:", generated_signature);
        console.error("- Received Signature:", razorpay_signature);
        console.error("- Expected Payload:", razorpay_order_id + "|" + razorpay_payment_id);
        console.error("- Active Key ID:", RAZORPAY_KEY_ID);
        console.error("- Active Key Secret (last 4 chars):", RAZORPAY_KEY_SECRET ? RAZORPAY_KEY_SECRET.slice(-4) : "None");
      }
    }

    if (!isSignatureValid) {
      return res.status(400).json({ success: false, message: "Payment signature verification failed" });
    }

    // Payment verified successfully! Save order details.
    const ordersCollection = mongoose.connection.db.collection('orders');
    const countersCollection = mongoose.connection.db.collection('counters');

    // Get next order sequence from counters collection
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

    // Sequence format padded to 5 digits, e.g. ORD-00860
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
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
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

    // Update user coins on backend
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

    // Auto-save delivery address to user's savedAddresses if it's new and not a duplicate
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

// Start Server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

