export async function onRequest() {
  return Response.json({
    status: "online",
    app: "Aurum Signals AI",
    api: "mounted",
    host: "Cloudflare Pages",
    timestamp: new Date().toISOString()
  });
}
