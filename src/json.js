export class Json {
  /** @param {unknown} body @param {number} [status] */
  static response(body, status = 200) {
    if (body == null) return new Response(null, { status: 202 });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }

  /** @param {string} body @param {number} [status] */
  static text(body, status = 200) {
    return new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });
  }
}
