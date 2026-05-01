const mongoose = require("mongoose");

const guestBookCommentSchema = new mongoose.Schema({
  profileUserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true, index: true },
  authorId: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  authorName: { type: String, required: true },
  message: { type: String, required: true, maxlength: 100 },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model("GuestBookComment", guestBookCommentSchema);
