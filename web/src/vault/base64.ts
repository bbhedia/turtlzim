// Bytes as text and back, for what is sent to and from the core (its messages are text): a backup goes in pieces.

/** The bytes as base64 (in pieces, so that a big array does not become too many arguments of one call). */
export function bytesToBase64(bytes: Uint8Array): string {
  let text = "";
  for (let at = 0; at < bytes.length; at += 0x8000) text += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(text);
}

/** The bytes of a base64 text. Throws if it is not one. */
export function base64ToBytes(text: string): Uint8Array {
  const raw = atob(text);
  const bytes = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}
