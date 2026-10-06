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

/** The value `key` has in `table`, if the table itself has it (not `constructor` or `toString` from `Object`). */
function own(table: Record<string, string>, key: string): string | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/** The media type a file with this name has, or `application/octet-stream` if the name doesn't say. */
export function mediaTypeFor(path: string): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return (dot > 0 ? own(TYPES, name.slice(dot + 1).toLowerCase()) : undefined) ?? "application/octet-stream";
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

const EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
};

/** Whether a name is what a browser calls a picture that came from the clipboard (it has no real name). */
function isNameless(name: string): boolean {
  return name.trim() === "" || /^image\.(png|jpe?g|gif|webp|bmp)$/i.test(name.trim());
}

/**
 * What to call a file that came with `name` (which may be empty or generic, as a pasted screenshot's
 * is): its own name, or else when it was made, `Pasted image 2026-10-06 10.15.30.png`.
 */
export function attachmentName(file: { name: string; type: string }, now: Date = new Date()): string {
  if (!isNameless(file.name)) return file.name;
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${pad(now.getSeconds())}`;
  const extension = own(EXTENSIONS, file.type.toLowerCase()) ?? (file.type.startsWith("image/") ? "png" : "bin");
  return `Pasted ${file.type.startsWith("image/") ? "image" : "file"} ${stamp}.${extension}`;
}

/** A size for people: `812 B`, `3.4 KB`, `1.2 MB`. */
export function formatSize(bytes: number): string {
  if (bytes < 1000) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1000;
  let unit = 0;
  while (value >= 999.95 && unit < units.length - 1) {
    value /= 1000;
    unit++;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const isSvg = (type: string): boolean => /^image\/svg\+xml$/i.test(type.trim());

function base64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

/**
 * An address to show a picture from, and how to let go of it. A picture is shown through an `<img>`,
 * where nothing in it can run. But an address can also be opened as a page of its own (the browser's
 * "Open image in new tab", or dragging the picture onto the tab strip), and an SVG opened like that is
 * a document that runs its scripts as the site that made the address. A `blob:` address is made by
 * this site, so it would run them as this site, with the notebooks in reach; an SVG therefore gets a
 * `data:` address, which has no site to run as. Any other picture is an image whatever it holds, and
 * keeps the cheaper `blob:` address.
 */
export async function pictureAddress(blob: Blob): Promise<{ url: string; release: () => void }> {
  if (isSvg(blob.type)) {
    return { url: `data:image/svg+xml;base64,${base64(new Uint8Array(await blob.arrayBuffer()))}`, release: () => {} };
  }
  const url = URL.createObjectURL(blob);
  return { url, release: () => URL.revokeObjectURL(url) };
}
