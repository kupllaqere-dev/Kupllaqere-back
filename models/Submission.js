const mongoose = require("mongoose");
const { CATEGORY_SUBCATEGORIES } = require("./Item");

const variantSchema = new mongoose.Schema(
  {
    color: { type: String },
    imageUrl: { type: String, required: true },
    thumbnailUrl: { type: String },
  },
  { _id: false }
);

const submissionSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 40 },
    groupCode: { type: String, required: true, index: true },
    category: { type: String, required: true, enum: Object.keys(CATEGORY_SUBCATEGORIES) },
    subcategory: { type: String, required: true },
    gender: { type: String, required: true, enum: ["male", "female"] },
    variants: [variantSchema],
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    status: { type: String, enum: ["pending", "approved", "declined"], default: "pending" },
    adminNote: { type: String, default: "", maxlength: 500 },
    // Set fields — null for single items
    setCode: { type: String, index: true, sparse: true, default: null },
    isSet: { type: Boolean, default: false },
    setPosition: { type: Number, default: null },
  },
  { timestamps: true }
);

submissionSchema.path("subcategory").validate(function (value) {
  const allowed = CATEGORY_SUBCATEGORIES[this.category];
  return allowed && allowed.includes(value);
}, "Invalid subcategory for the given category.");

module.exports = mongoose.model("Submission", submissionSchema);
