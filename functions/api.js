import aurumApiHandler from "../api/index.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff"
  });
  let statusCode = 200;
  let response = null;
  const req = {
    method: context.request.method,
    headers: Object.fromEntries(context.request.headers.entries()),
    query: Object.fromEntries(url.searchParams.entries())
  };
  const res = {
    setHeader(name, value) { headers.set(name, String(value)); },
    status(code) { statusCode = code; return this; },
    json(payload) {
      response = Response.json(payload, { status: statusCode, headers });
      return response;
    }
  };

  try {
    const result = await aurumApiHandler(req, res);
    if (result instanceof Response) return result;
    return response || Response.json({
      status: "error",
      code: "EMPTY_API_RESPONSE",
      message: "API tidak menghasilkan respons"
    }, { status: 502, headers });
  } catch (error) {
    console.error("AURUM Pages market API error:", error);
    return Response.json({
      status: "error",
      message: "Terjadi kesalahan server"
    }, { status: 500, headers });
  }
}
