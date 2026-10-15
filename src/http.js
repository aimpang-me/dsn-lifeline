const ALLOWED = new Set(["eyes.nasa.gov"]);

export class Http {
  /**
   * @param {typeof fetch} fetchImpl
   * @param {{ delay: (ms: number, fn: () => void) => { clear: () => void } }} clock
   * @param {string} url
   * @param {number} ms
   */
  static async fetch(fetchImpl, clock, url, ms) {
    const host = new URL(url).host;
    if (!ALLOWED.has(host)) throw new Error("host_blocked");
    const ctrl = new AbortController();
    const timer = clock.delay(ms, () => ctrl.abort());
    try {
      const res = await fetchImpl(url, { method: "GET", signal: ctrl.signal });
      const text = await Http.readBody(res, ctrl.signal);
      return { status: res.status, ok: res.ok, text };
    } catch (err) {
      if (ctrl.signal.aborted) throw new Error("timeout");
      throw err;
    } finally {
      timer.clear();
    }
  }

  /**
   * The abort timer stays armed until the body finishes or the deadline fires.
   * @param {Response} res
   * @param {AbortSignal} signal
   */
  static readBody(res, signal) {
    if (signal.aborted) return Promise.reject(new Error("timeout"));
    return new Promise((resolve, reject) => {
      const onAbort = () => reject(new Error("timeout"));
      signal.addEventListener("abort", onAbort, { once: true });
      res.text().then(
        (text) => {
          signal.removeEventListener("abort", onAbort);
          resolve(text);
        },
        (err) => {
          signal.removeEventListener("abort", onAbort);
          reject(err);
        },
      );
    });
  }
}
