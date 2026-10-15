export class Clock {
  now() {
    return Date.now();
  }

  /** @param {number} ms @param {() => void} fn */
  delay(ms, fn) {
    const id = setTimeout(fn, ms);
    return { clear() { clearTimeout(id); } };
  }
}
