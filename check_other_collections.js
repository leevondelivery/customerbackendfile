const mongoose = require('mongoose');

const MONGODB_URI = "mongodb+srv://omnia771148_db_user:Nk1wTwqHMKCzqti7@cluster0.nbhpjuy.mongodb.net/?appName=Cluster0";

async function check() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB Atlas");
    
    const db = mongoose.connection.db;
    const collections = [
      'acceptedbyrestorents',
      'acceptedbydeliveries',
      'pendingpayments',
      'locations',
      'adminfcmtokens',
      'carousel',
      'paymentstorestorents',
      'pendingpaymentsofdeliveryboy',
      'counters',
      'itemstatus',
      'Deliveryboynewadd',
      'users',
      'carousels',
      'restuarentusers',
      'restaurantstatuses',
      'buttonstatuses',
      'deliveryboyusers',
      'restaurants'
    ];

    for (let colName of collections) {
      const count = await db.collection(colName).countDocuments({});
      console.log(`Collection ${colName} has ${count} documents.`);
      if (count > 0 && ['acceptedbyrestorents', 'acceptedbydeliveries', 'pendingpayments', 'pendingpaymentsofdeliveryboy'].includes(colName)) {
        const sample = await db.collection(colName).findOne({});
        console.log(`Sample from ${colName}:`, JSON.stringify(sample, null, 2));
      }
    }

  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

check();
