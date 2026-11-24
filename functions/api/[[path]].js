import marketHandler from "../../api/index.js";
import signalsHandler from "../../api/signals.js";
import fundamentalHandler from "../../api/fundamental.js";
import pushSubscribeHandler from "../../api/push-subscribe.js";

const handlers = {
  signals: signalsHandler,
  fundamental: fundamentalHandler,
  "push-subscribe": pushSubscribeHandler
};

function createResponseBridge() {
  let statusCode = 200;
  const headers = new Headers({
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store, max-age=0",
    "X-Content-Type-Options": "nosniff"
  });
  let response = null;

  return {
    headers,
    res: {
      setHeader(name, value) {
        headers.set(name, String(value));
      },
      status(code) {
        statusCode = code;
        return this;
      },
      json(payload) {
        response = new Response(JSON.stringify(payload), {
          status: statusCode,
          headers
        });
        return response;
      }
    },
    get response() {
      return response;
    }
  };
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  const route = (context.params?.path || "").toString().replace(/^\/+|\/+$/g, "");

  // The scheduled scanner is intentionally not exposed as a Pages Function:
  // its notification delivery uses the Node web-push transport. Keep it
  // disabled until a dedicated Cloudflare Worker Cron deployment is configured.
  if (route === "cron") {
    return Response.json({
      status: "not_configured",
      code: "CRON_RUNTIME_NOT_CONFIGURED",
      message: "Pemindai terjadwal belum dipasang pada runtime Cloudflare."
    }, {
      status: 503,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff"
      }
    });
  }

  // Cloudflare Pages resolves /api through this catch-all function with an
  // empty path parameter. Route the bare /api endpoint to the market handler.
  const handler = route ? handlers[route] : marketHandler;
  if (!handler) {
    return Response.json({
      status: "error",
      code: "NOT_FOUND",
      message: "API route tidak ditemukan"
    }, { status: 404 });
  }

  const bridge = createResponseBridge();
  const request = context.request;
  let body;

  if (request.method !== "GET" && request.method !== "HEAD") {
    const contentType = request.headers.get("content-type") || "";
    if (contentType.includes("application/json")) {
      try {
        body = await request.json();
      } catch {
        return Response.json({
          status: "error",
          code: "INVALID_JSON",
          message: "Body JSON tidak valid"
        }, { status: 400 });
      }
    }
  }

  const req = {
    method: request.method,
    query: Object.fromEntries(url.searchParams.entries()),
    headers: Object.fromEntries(request.headers.entries()),
    body
  };

  try {
    const result = await handler(req, bridge.res);
    if (result instanceof Response) return result;
    return bridge.response || Response.json({
      status: "error",
      code: "EMPTY_API_RESPONSE",
      message: "API tidak menghasilkan respons"
    }, { status: 502 });
  } catch (error) {
    console.error("AURUM Pages API error:", route, error);
    return Response.json({
      status: "error",
      message: "Terjadi kesalahan server"
    }, {
      status: 500,
      headers: {
        "Cache-Control": "no-store, max-age=0",
        "X-Content-Type-Options": "nosniff"
      }
    });
  }
}
