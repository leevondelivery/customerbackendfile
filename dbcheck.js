const mongoose = require('mongoose');

const MONGODB_URI = "mongodb+srv://omnia771148_db_user:Nk1wTwqHMKCzqti7@cluster0.nbhpjuy.mongodb.net/?appName=Cluster0";

async function check() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("Connected to MongoDB Atlas");
    
    // Check one document from orderreviews
    const reviewsCol = mongoose.connection.db.collection('orderreviews');
    const sampleReview = await reviewsCol.findOne({});
    console.log("Sample Review:", JSON.stringify(sampleReview, null, 2));

    const reviewsCount = await reviewsCol.countDocuments({});
    console.log("Total reviews count:", reviewsCount);

  } catch (err) {
    console.error(err);
  } finally {
    await mongoose.disconnect();
  }
}

check();
