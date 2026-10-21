// Thumbnails arrive from the API as public Storage URLs of the worker's `thumbs` bucket. Only those URLs and plain
// JPEG or PNG data URLs (used by the offline mock) are accepted. Anything else (other hosts, other paths, other
// image types, markup) is ignored, so a malformed value can never reach an image source.

const STORED_THUMB =
  /^https:\/\/[a-z0-9.-]+\.supabase\.co\/storage\/v1\/object\/public\/thumbs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[1-9][0-9]{0,18}\.(?:jpg|png)$/i;
const DATA_THUMB = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/;

/** Returns the value when it is an accepted thumbnail address, otherwise null. */
export function safeThumbSource(value) {
  if (typeof value !== "string") return null;
  return STORED_THUMB.test(value) || DATA_THUMB.test(value) ? value : null;
}
