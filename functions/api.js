import aurumApiHandler from "../api/index.js";

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const query = Object.fromEntries(url.searchParams.entries());
  const req = { query };

  let response = null;
  let statusCode = 200;
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(payload) {
      response = new Response(JSON.stringify(payload), {
        status: statusCode,
        headers: { "Content-Type": "application/json; charset=utf-8" }
      });
      return response;
    }
  };

  try {
    const result = await aurumApiHandler(req, res);
    return result instanceof Response
      ? result
      : response || new Response(JSON.stringify({
          status: "error",
          message: "API tidak menghasilkan respons"
        }), {
          status: 502,
          headers: { "Content-Type": "application/json; charset=utf-8" }
        });
  } catch (error) {
    console.error("AURUM Pages API error:", error);
    return new Response(JSON.stringify({
      status: "error",
      message: "Terjadi kesalahan server"
    }), {
      status: 500,
      headers: { "Content-Type": "application/json; charset=utf-8" }
    });
  }
}
