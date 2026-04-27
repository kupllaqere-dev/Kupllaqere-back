const mongoose = require("mongoose");

const CATEGORY_SUBCATEGORIES = {
  tops: ["longSleeve", "shortSleeve", "sleeveless", "baggy"],
  bottoms: ["pants", "skinny", "shorts", "skirt"],
  onePiece: ["overall, dress"],
  coats: ["jackets", "vests", "hoodie"],
  head: ["hats", "sunglasses", "decorations", "horns", "halos"],
  hair: ["short", "medium", "long", "facial"],
  accessories: ["bracelets", "belts", "neckwear", "necklace", "bags", "nails"],
  feet: ["shoes", "boots", "slipOns", "socks"],
  hands: ["gloves", "handheld"],
};

const itemSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, maxlength: 40 },
    gender: { type: String, enum: ["male", "female"] },
    category: {
      type: String,
      required: true,
      enum: Object.keys(CATEGORY_SUBCATEGORIES),
    },
    subcategory: { type: String, required: true },
    imageUrl: { type: String, required: true },
    thumbnailUrl: { type: String },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
  },
  { timestamps: true },
);

itemSchema.path("subcategory").validate(function (value) {
  const allowed = CATEGORY_SUBCATEGORIES[this.category];
  return allowed && allowed.includes(value);
}, "Invalid subcategory for the given category.");

module.exports = mongoose.model("Item", itemSchema);
module.exports.CATEGORY_SUBCATEGORIES = CATEGORY_SUBCATEGORIES;
