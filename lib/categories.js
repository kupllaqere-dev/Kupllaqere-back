const CATEGORY_SUBCATEGORIES = {
  tops:        ["longSleeve", "shortSleeve", "sleeveless", "baggy"],
  bottoms:     ["pants", "skinny", "shorts", "skirt"],
  onePiece:    ["overall", "dress"],
  coats:       ["jackets", "vests", "hoodie"],
  head:        ["hats", "sunglasses", "decorations", "horns", "halos"],
  hair:        ["short", "medium", "long"],
  accessories: ["bracelets", "belts", "neckwear", "necklace", "bags", "nails"],
  feet:        ["shoes", "boots", "slipOns", "socks"],
  hands:       ["gloves", "handheld"],
  appearance:  ["eyes", "eyebrows", "nose", "mouth", "beard"],
  tattoos:     ["back", "chest", "arms", "legs"],
};

// Maps every outfit slot key → { category, subcategory?, subcategories? }
// subcategory  — item must have exactly this subcategory
// subcategories — item must have one of these subcategories
// neither       — any subcategory of the category is valid
const VALID_SLOTS = {
  // appearance — each subcategory is its own independent slot
  eyes:          { category: "appearance", subcategory: "eyes" },
  eyebrows:      { category: "appearance", subcategory: "eyebrows" },
  nose:          { category: "appearance", subcategory: "nose" },
  mouth:         { category: "appearance", subcategory: "mouth" },
  beard:         { category: "appearance", subcategory: "beard" },
  // tattoos — each subcategory is its own independent slot
  tattoo_back:   { category: "tattoos", subcategory: "back" },
  tattoo_chest:  { category: "tattoos", subcategory: "chest" },
  tattoo_arms:   { category: "tattoos", subcategory: "arms" },
  tattoo_legs:   { category: "tattoos", subcategory: "legs" },
  // hair — one slot, any subcategory
  hair:          { category: "hair" },
  // tops / bottoms / onePiece — one slot each, any subcategory
  tops:          { category: "tops" },
  bottoms:       { category: "bottoms" },
  onePiece:      { category: "onePiece" },
  // coats — split into jacket/hoodie slot and vest slot
  coatMain:      { category: "coats", subcategories: ["jackets", "hoodie"] },
  vest:          { category: "coats", subcategory: "vests" },
  // feet — split into footwear slot and socks slot
  footwear:      { category: "feet", subcategories: ["shoes", "boots", "slipOns"] },
  socks:         { category: "feet", subcategory: "socks" },
  // head — each subcategory is its own independent slot
  hats:          { category: "head", subcategory: "hats" },
  sunglasses:    { category: "head", subcategory: "sunglasses" },
  decorations:   { category: "head", subcategory: "decorations" },
  horns:         { category: "head", subcategory: "horns" },
  halos:         { category: "head", subcategory: "halos" },
  // accessories — each subcategory is its own independent slot
  bracelets:     { category: "accessories", subcategory: "bracelets" },
  belts:         { category: "accessories", subcategory: "belts" },
  neckwear:      { category: "accessories", subcategory: "neckwear" },
  necklace:      { category: "accessories", subcategory: "necklace" },
  bags:          { category: "accessories", subcategory: "bags" },
  nails:         { category: "accessories", subcategory: "nails" },
  // hands — each subcategory is its own independent slot
  gloves:        { category: "hands", subcategory: "gloves" },
  handheld:      { category: "hands", subcategory: "handheld" },
};

module.exports = { CATEGORY_SUBCATEGORIES, VALID_SLOTS };
