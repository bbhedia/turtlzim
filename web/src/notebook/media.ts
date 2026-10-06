// What kind of thing a file is, from its name: the media type a Blob needs to be shown or downloaded
// properly. Browsers give a file picked from disk a type of their own; a file out of a zip, or one
// made in memory, has none, and an image without one is not drawn.

const TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  jpe: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  csv: "text/csv",
  json: "application/json",
  xml: "application/xml",
  html: "text/html",
  htm: "text/html",
  zip: "application/zip",
  gz: "application/gzip",
  tar: "application/x-tar",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  wav: "audio/wav",
  mp4: "video/mp4",
  webm: "video/webm",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
};

/** The media type a file with this name has, or `application/octet-stream` if the name doesn't say. */
export function mediaTypeFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 && TYPES[name.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

/**
 * Whether a file of this type is shown as a picture. Only types a browser draws in an `<img>` count:
 * a picture there cannot run a script, which is why an attached SVG is drawn this way and never
 * opened as a page of its own.
 */
export function isImageType(type: string): boolean {
  return /^image\/(png|jpeg|gif|webp|avif|bmp|x-icon|svg\+xml)$/i.test(type.trim());
}

/** The blob with a media type: its own if it has one, else the one its name gives. */
export function typed(blob: Blob, path: string): Blob {
  return blob.type ? blob : new Blob([blob], { type: mediaTypeFor(path) });
}
