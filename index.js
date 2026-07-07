require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const Razorpay = require('razorpay');

const app = express();

// Initialize Razorpay with fallback test keys
const RAZORPAY_KEY_ID = process.env.RAZORPAY_KEY_ID || 'rzp_test_T96hBRy748HTkq';
const RAZORPAY_KEY_SECRET = process.env.RAZORPAY_KEY_SECRET || 'RIFn7bKzOafpJKOLCd0OMU1k';

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
  const { flatNo, street, landmark, tag } = req.body;
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
      tag, // 'Home', 'Office', 'Apartment', 'Other'
      label: tag, // support database compatibility
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


// POST /payment/order - Create a Razorpay payment order
app.post('/payment/order', async (req, res) => {
  const { amount, userId } = req.body;
  if (!amount) {
    return res.status(400).json({ success: false, message: "Amount is required" });
  }
  try {
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
    deliveryAddressInfo
  } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    return res.status(400).json({ success: false, message: "Payment credentials are required" });
  }

  try {
    // Verify payment signature
    const crypto = require('crypto');
    const generated_signature = crypto
      .createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(razorpay_order_id + "|" + razorpay_payment_id)
      .digest('hex');

    if (generated_signature !== razorpay_signature) {
      console.error("Invalid Razorpay signature");
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
      orderId: generatedOrderId,
      razorpayOrderId: razorpay_order_id,
      razorpayPaymentId: razorpay_payment_id,
      paymentStatus: 'Paid',
      coinsEarned: Number(coinsEarned || 0),
      userName: userName || '',
      userEmail: userEmail || '',
      userPhone: userPhone || '',
      flatNo: deliveryAddressInfo?.flatNo || '',
      street: deliveryAddressInfo?.street || '',
      landmark: deliveryAddressInfo?.landmark || '',
      deliveryAddress: `${deliveryAddressInfo?.flatNo || ''}, ${deliveryAddressInfo?.street || ''}${deliveryAddressInfo?.landmark ? ' , ' + deliveryAddressInfo.landmark : ''}`,
      restaurantId: String(restaurantId || cartItems[0]?.restId || ''),
      restaurantName: restaurantName || cartItems[0]?.restaurantName || '',
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

// Start Server
app.listen(PORT, () => {
  console.log(`Backend server running on port ${PORT}`);
});

