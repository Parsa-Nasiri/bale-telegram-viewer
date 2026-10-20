// Thumbnails arrive from the API as data URLs. Only plain JPEG or PNG image data is accepted; anything else
// (links, other image types, text) is ignored, so a malformed value can never reach an image source.

const IMAGE_DATA_URL = /^data:image\/(jpeg|png);base64,[A-Za-z0-9+/]+=*$/;

/** Returns the value when it is a JPEG or PNG data URL, otherwise null. */
export function safeThumbSource(value) {
  return typeof value === "string" && IMAGE_DATA_URL.test(value) ? value : null;
}
