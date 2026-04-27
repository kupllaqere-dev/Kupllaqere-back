const mongoose = require("mongoose");
const bcrypt = require("bcryptjs");

const userSchema = new mongoose.Schema(
  {
    name: { type: String, trim: true, default: "" },
    email: {
      type: String,
      unique: true,
      sparse: true,
      lowercase: true,
      trim: true,
    },
    password: { type: String },
    gender: { type: String, enum: ["male", "female"], default: "female" },
    avatar: { type: String, default: "" },
    bio: { type: String, default: "", maxlength: 500, trim: true },
    selectedBadge: {
      type: String,
      enum: ["diamond", "flame", "medal", "paint", "verified", null],
      default: null,
    },
    isGuest: { type: Boolean, default: false },
    isBanned: { type: Boolean, default: false },
    role: { type: String, enum: ["player", "admin"], default: "player" },
    googleId: { type: String, unique: true, sparse: true },

    // Currencies
    coins: { type: Number, default: 0 },
    gems: { type: Number, default: 0 },

    // Friends
    friends: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", default: [] }],
    friendRequestsReceived: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", default: [] }],
    friendRequestsSent: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", default: [] }],

    // Soul mate (only one at a time)
    soulMate: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    soulMateRequestSent: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    soulMateRequestsReceived: [{ type: mongoose.Schema.Types.ObjectId, ref: "User", default: [] }],

    // Customization 
    customization: {
      tops: {
        longSleeve: { type: String, default: null },
        shortSleeve: { type: String, default: null },
        sleeveless: { type: String, default: null },
        baggy: { type: String, default: null },
      },
      bottoms: {
        pants: { type: String, default: null },
        skinny: { type: String, default: null },
        shorts: { type: String, default: null },
      },
      coats: {
        jackets: { type: String, default: null },
        vests: { type: String, default: null },
        hoodie: { type: String, default: null },
      },
      head: {
        hats: { type: String, default: null },
        sunglasses: { type: String, default: null },
        decorations: { type: String, default: null },
        horns: { type: String, default: null },
        halos: { type: String, default: null },
      },
      hair: {
        short: { type: String, default: null },
        medium: { type: String, default: null },
        long: { type: String, default: null },
        facial: { type: String, default: null },
      },
      accessories: {
        bracelets: { type: String, default: null },
        belts: { type: String, default: null },
        neckwear: { type: String, default: null },
        necklace: { type: String, default: null },
        bags: { type: String, default: null },
        nails: { type: String, default: null },
      },
      feet: {
        shoes: { type: String, default: null },
        boots: { type: String, default: null },
        slipOns: { type: String, default: null },
        socks: { type: String, default: null },
      },
      hands: {
        gloves: { type: String, default: null },
        handheld: { type: String, default: null },
      },
    },
  },
  { timestamps: true },
);

userSchema.pre("save", async function () {
  if (!this.isModified("password") || !this.password) return;
  this.password = await bcrypt.hash(this.password, 10);
});

userSchema.methods.comparePassword = function (candidate) {
  return bcrypt.compare(candidate, this.password);
};

userSchema.methods.needsSetup = function () {
  return !this.isGuest && !this.name;
};

userSchema.methods.toPublic = function () {
  const obj = {
    id: this._id,
    name: this.name,
    email: this.email,
    gender: this.gender,
    avatar: this.avatar,
    bio: this.bio,
    selectedBadge: this.selectedBadge,
    isGuest: this.isGuest,
    isBanned: this.isBanned,
    role: this.role,
    coins: this.coins,
    gems: this.gems,
    customization: this.customization,
    soulMate: this.soulMate || null,
  };
  if (this.needsSetup()) obj.needsSetup = true;
  return obj;
};

module.exports = mongoose.model("User", userSchema);
