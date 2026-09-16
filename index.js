const checkIsUserBlocked = (user) => {
  if (!user || typeof user !== 'object') return false;
  return (
    user.isBlocked === true ||
    String(user.isBlocked).toLowerCase() === 'true' ||
    user.is_blocked === true ||
    String(user.is_blocked).toLowerCase() === 'true' ||
    user.blocked === true ||
    String(user.blocked).toLowerCase() === 'true' ||
    user.blickstatus === false ||
    String(user.blickstatus).toLowerCase() === 'false' ||
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
  savedAddresses: { type: Array, default: [] },
    termsAccepted: { type: Boolean, default: false },
    termsAcceptedAt: { type: String }
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

// [Duplicate REVIEWS ENDPOINTS removed - handled by unified handleGetUserReviews & handleSaveReview]




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
      coinsEarned: await computeCoinsEarnedForOrder(totalPrice, grandTotal, coinsEarned || req.body.coins),
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

async function computeCoinsEarnedForOrder(totalPrice, grandTotal, coinsEarnedReq) {
  let coins = Number(coinsEarnedReq || 0);
  if (coins > 0) return coins;

  try {
    const feesConfig = await mongoose.connection.db.collection('feesconfigs').findOne({ key: 'global' });
    if (feesConfig && feesConfig.isCoinsActive !== false) {
      const subTotal = Number(totalPrice || grandTotal || 0);
      const cMin = Number(feesConfig.coinMinOrderAmount ?? 200);
      const cBase = Number(feesConfig.coinBaseAmount ?? 10);
      const cStep = Number(feesConfig.coinStepAmount ?? 100);
      const cStepVal = Number(feesConfig.coinStepValue ?? 5);
      const cMax = Number(feesConfig.coinMaxLimit ?? 100);
      const cMaxOrder = Number(feesConfig.coinMaxThreshold ?? 1000);

      if (subTotal >= cMaxOrder) {
        coins = cMax;
      } else if (subTotal >= cMin) {
        coins = cBase + Math.floor((subTotal - cMin) / cStep) * cStepVal;
        coins = Math.min(coins, cMax);
      }
    }
  } catch (err) {
    console.warn('[ComputeCoins] Fallback computation error:', err.message);
  }
  return coins;
}


// Start Server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Backend server running on port ${PORT}`);
});
