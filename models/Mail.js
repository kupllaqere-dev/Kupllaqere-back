const mongoose = require("mongoose");

const mailSchema = new mongoose.Schema(
  {
    threadId: { type: String, required: true, index: true },
    from: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    to:   { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    subject: { type: String, required: true, maxlength: 100, trim: true },
    body:    { type: String, required: true, maxlength: 2000, trim: true },
    read:    { type: Boolean, default: false },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Mail", mailSchema);
