const mongoose = require('mongoose');

const MONGODB_URI = "mongodb+srv://omnia771148_db_user:Nk1wTwqHMKCzqti7@cluster0.nbhpjuy.mongodb.net/?appName=Cluster0";
const targetUserId = "6a3579405049fb87f94f96f2";

async function check() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB Atlas");
    
    const db = mongoose.connection.db;
    const collections = await db.listCollections().toArray();
    
    for (let col of collections) {
      const name = col.name;
      const count = await db.collection(name).countDocuments({});
      if (count > 0) {
        // Try querying with string or ObjectId userId
        const query = {
          $or: [
            { userId: targetUserId },
            { userId: new mongoose.Types.ObjectId(targetUserId) }
          ]
        };
        const doc = await db.collection(name).findOne(query);
        if (doc) {
          console.log(`\nFound matching doc in collection '${name}':`);
          console.log(JSON.stringify(doc, null, 2));
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
