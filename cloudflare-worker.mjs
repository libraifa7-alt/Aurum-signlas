import express from "express";
import { env } from "cloudflare:workers";
import { httpServerHandler } from "cloudflare:node";
import aurumApiHandler from "./api/index.js";

const app = express();

app.disable("x-powered-by");
app.get("/api", aurumApiHandler);
app.get("/api/", aurumApiHandler);

app.get("/api/health", (req, res) => {
  res.status(200).json({
    status: "online",
    app: "Aurum Signals AI",
    api: "mounted",
    platform: "cloudflare-workers",
    timestamp: new Date().toISOString()
  });
});

app.all("/api/{*splat}", (req, res) => {
  res.status(404).json({
    status: "error",
    message: "API route tidak ditemukan"
  });
});

async function serveStaticAsset(req, res) {
  try {
    const assetUrl = new URL(req.originalUrl, "https://aurum-assets.invalid");
    const assetResponse = await env.ASSETS.fetch(new Request(assetUrl));

    assetResponse.headers.forEach((value, key) => {
      res.setHeader(key, value);
    });

    res.status(assetResponse.status);
    if (req.method === "HEAD" || assetResponse.status === 204 || assetResponse.status === 304) {
      return res.end();
    }

    const body = await assetResponse.arrayBuffer();
    return res.end(Buffer.from(body));
  } catch (error) {
    console.error("AURUM static asset error:", error);
    return res.status(500).send("AURUM asset service unavailable");
  }
}

app.get("/{*path}", serveStaticAsset);

app.listen(3000);

export default httpServerHandler({ port: 3000 });
