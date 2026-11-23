const test = require("node:test");
const assert = require("node:assert/strict");
const app = require("../server.js");

test("alternate Express host serves PWA and mounts the shared API handler", async () => {
  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });

  const address = server.address();
  const base = "http://127.0.0.1:" + address.port;

  try {
    const health = await fetch(base + "/api/health");
    assert.equal(health.status, 200);
    assert.equal((await health.json()).api, "mounted");

    const home = await fetch(base + "/");
    assert.equal(home.status, 200);
    assert.match(await home.text(), /AURUM|Aurum/i);

    const invalidInterval = await fetch(base + "/api?symbol=XAU%2FUSD&interval=INVALID");
    assert.equal(invalidInterval.status, 400);
    assert.equal((await invalidInterval.json()).code, "INVALID_INTERVAL");
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
