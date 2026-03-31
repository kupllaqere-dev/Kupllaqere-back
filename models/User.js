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
    isGuest: { type: Boolean, default: false },
    googleId: { type: String, unique: true, sparse: true },
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
    isGuest: this.isGuest,
  };
  if (this.needsSetup()) obj.needsSetup = true;
  return obj;
};

module.exports = mongoose.model("User", userSchema);
