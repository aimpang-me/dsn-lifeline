export class Bytes {
  /** @param {string} text */
  static length(text) {
    return new TextEncoder().encode(text).byteLength;
  }
}
