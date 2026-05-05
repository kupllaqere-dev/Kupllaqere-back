const supabase = require("./supabase");

const BUCKET = process.env.SUPABASE_STORAGE_BUCKET || "kupllaqere";

async function uploadFile(path, buffer, contentType = "image/webp") {
  const { error } = await supabase.storage
    .from(BUCKET)
    .upload(path, buffer, { contentType, upsert: true });
  if (error) throw error;
  return supabase.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

async function deleteFiles(paths) {
  if (!paths.length) return;
  const { error } = await supabase.storage.from(BUCKET).remove(paths);
  if (error) console.error("Storage delete error:", error);
}

module.exports = { uploadFile, deleteFiles };
