const mongoose = require('mongoose');

const MONGODB_URI = "mongodb+srv://omnia771148_db_user:Nk1wTwqHMKCzqti7@cluster0.nbhpjuy.mongodb.net/?appName=Cluster0";

async function check() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB Atlas");
    
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    console.log("Collections:");
    for (let col of collections) {
      console.log(` - ${col.name}`);
    }

    // Let's also search if there's any collection with "order" in it, and check their counts/latest doc
    for (let col of collections) {
      if (col.name.toLowerCase().includes('order')) {
        const count = await db.collection(col.name).countDocuments({});
        console.log(`\nCollection ${col.name} has ${count} documents.`);
        if (count > 0) {
          const sample = await db.collection(col.name).findOne({});
          console.log(`Sample from ${col.name}:`, JSON.stringify(sample, null, 2));
        }
      }
    }

  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

check();
