const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/index.js");
const healthHandler = require("../api/health.js");
const fs = require("node:fs");
const { normalizeCandles } = require("../api/engine.js");

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
    headers: {},
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    }
  };
}

function yahooPayload(timestamp) {
  return {
    chart: {
      result: [{
        timestamp: [timestamp],
        indicators: {
          quote: [{
            open: [4200],
            high: [4210],
            low: [4190],
            close: [4205],
            volume: [123]
          }]
        }
      }]
    }
  };
}

function yahooSeriesPayload(timestamps) {
  return {
    chart: {
      result: [{
        timestamp: timestamps,
        indicators: {
          quote: [{
            open: timestamps.map((_, i) => 4200 + i),
            high: timestamps.map((_, i) => 4210 + i),
            low: timestamps.map((_, i) => 4190 - i),
            close: timestamps.map((_, i) => 4205 + i),
            volume: timestamps.map((_, i) => 100 + i)
          }]
        }
      }]
    }
  };
}

async function requestMarket(symbol, interval, fetchImpl) {
  globalThis.aurumCache = new Map();
  const originalFetch = global.fetch;
  global.fetch = fetchImpl;
  try {
    const res = responseRecorder();
    await handler({ method: "GET", query: { symbol, interval } }, res);
    return res;
  } finally {
    global.fetch = originalFetch;
  }
}

test("rejects non-GET market requests before contacting providers", async () => {
  globalThis.aurumCache = new Map();
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("Provider must not be called for a non-GET request");
  };
  try {
    const res = responseRecorder();
    await handler({ method: "POST", query: { symbol: "XAU/USD", interval: "M15" } }, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.payload.code, "METHOD_NOT_ALLOWED");
    assert.equal(res.headers.Allow, "GET");
    assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("rejects unsupported market symbols before contacting providers", async () => {
  let fetchCalled = false;
  const res = await requestMarket("UNSUPPORTED/PAIR", "M15", async () => {
    fetchCalled = true;
    throw new Error("Provider must not be called for an unsupported symbol");
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, "INVALID_SYMBOL");
  assert.equal(res.payload.receivedSymbol, "UNSUPPORTED/PAIR");
  assert.equal(fetchCalled, false);
});

test("rejects unsupported market intervals instead of silently using M15", async () => {
  let fetchCalled = false;
  const res = await requestMarket("WTI", "INVALID", async () => {
    fetchCalled = true;
    throw new Error("Provider must not be called for an invalid interval");
  });

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, "INVALID_INTERVAL");
  assert.equal(res.payload.receivedInterval, "INVALID");
  assert.equal(fetchCalled, false);
});

test("marks recent Yahoo BTC candles fresh and applies a provider timeout", async () => {
  const timestamp = Math.floor(Date.now() / 1000) - 60;
  let requestOptions;
  const res = await requestMarket("BTC/USD", "M1", async (_url, options) => {
    requestOptions = options;
    return {
      ok: true,
      async json() { return yahooPayload(timestamp); }
    };
  });
  assert.ok(requestOptions?.signal instanceof AbortSignal);
  assert.equal(requestOptions.signal.aborted, false);

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.candleStatus, "fresh_candles");
  assert.equal(res.payload.candleAgeSeconds <= 120, true);
  assert.equal(res.payload.source, "Yahoo Finance (BTC-USD)");
});

test("marks old Yahoo WTI candles stale even when fetched successfully", async () => {
  const timestamp = Math.floor(Date.now() / 1000) - 10 * 60;
  const res = await requestMarket("WTI", "M1", async () => ({
    ok: true,
    async json() { return yahooPayload(timestamp); }
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.candleStatus, "stale_candles");
  assert.equal(res.payload.candleAgeSeconds >= 600, true);
});

test("rechecks cached Yahoo candles and does not trust their previous fresh label", async () => {
  const oldTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  globalThis.aurumCache = new Map([[
    "WTI:15min:yahoo:v3",
    {
      time: Date.now(),
      data: {
        status: "success",
        symbol: "WTI",
        interval: "M15",
        source: "Yahoo Finance (CL=F)",
        candleStatus: "fresh_candles",
        candles: [{
          datetime: oldTimestamp,
          open: 4200,
          high: 4210,
          low: 4190,
          close: 4205,
          volume: 123
        }]
      }
    }
  ]]);

  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error("Fresh memory cache should avoid a provider request");
  };
  try {
    const res = responseRecorder();
    await handler({ query: { symbol: "WTI", interval: "M15" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.candleStatus, "stale_candles");
    assert.equal(res.payload.cache, "memory");
  } finally {
    global.fetch = originalFetch;
  }
});

test("rejects Yahoo candles timestamped materially in the future", async () => {
  const timestamp = Math.floor(Date.now() / 1000) + 5 * 60;
  const res = await requestMarket("BTC/USD", "M1", async () => ({
    ok: true,
    async json() { return yahooPayload(timestamp); }
  }));

  assert.equal(res.statusCode, 502);
  assert.match(res.payload.message, /candle/i);
});

test("frontend blocks signal generation unless backend marks candles fresh for every asset", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const start = html.indexOf("const signalDataIsFresh");
  const end = html.indexOf("const validTradePlan", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const freshnessGate = html.slice(start, end);
  assert.ok(freshnessGate.includes("chartFeedMeta?.candleStatus === 'fresh_candles'"));
  assert.ok(!freshnessGate.includes("!== 'XAU/USD'"));
});

test("TRAXA-aligned Aurum destinations exist and unsupported partner features are disclosed", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  for (const pageId of [
    "homePage", "marketDirectoryPage", "marketPage", "chartPage",
    "newsPage", "chatPage", "guidePage", "pnlPage",
    "partnerPage", "announcementsPage"
  ]) {
    assert.ok(html.includes('id="' + pageId + '"'), "Missing page: " + pageId);
  }
  assert.ok(html.includes("Pelacakan undangan, dashboard pendapatan, dan pembayaran komisi belum terhubung"));
  assert.ok(html.includes("Belum ada pengumuman resmi"));
});

test("navigation restores deep links, supports browser history, and safely falls back on malformed hashes", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const start = html.indexOf("function initAurumNavigation()");
  const end = html.indexOf("</script>", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const navigation = html.slice(start, end);
  assert.ok(navigation.includes("window.history.pushState"));
  assert.ok(navigation.includes("window.addEventListener('hashchange', restorePageFromAddress)"));
  assert.ok(navigation.includes("window.addEventListener('popstate', restorePageFromAddress)"));
  assert.ok(navigation.includes("validPages.has(requestedPage) ? requestedPage : 'homePage'"));
  assert.ok(navigation.includes("catch (_)"));
});

test("internal chart diagnostics never overwrite the customer-facing Aurum status", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  assert.equal((html.match(/id="aurumDebugStatus"/g) || []).length, 1);
  assert.ok(html.includes('<div class="status" role="status" aria-live="polite">● AURUM SIGNALS</div>'));
  assert.ok(!html.includes("document.querySelector('.status')"));
});

test("aggregates M45 only from three consecutive completed Yahoo M15 bars", async () => {
  const targetSeconds = 45 * 60;
  const bucketStart = Math.floor(Date.now() / 1000 / targetSeconds) * targetSeconds - targetSeconds;
  const timestamps = [bucketStart, bucketStart + 900, bucketStart + 1800];
  const res = await requestMarket("WTI", "M45", async () => ({
    ok: true,
    async json() { return yahooSeriesPayload(timestamps); }
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.candles.length, 1);
  assert.equal(res.payload.candles[0].datetime, new Date(bucketStart * 1000).toISOString());
  assert.equal(res.payload.candles[0].open, 4200);
  assert.equal(res.payload.candles[0].high, 4212);
  assert.equal(res.payload.candles[0].low, 4188);
  assert.equal(res.payload.candles[0].close, 4207);
  assert.equal(res.payload.candles[0].volume, 303);
});

test("aggregates H4 only from four consecutive completed Yahoo H1 bars", async () => {
  const targetSeconds = 4 * 60 * 60;
  const bucketStart = Math.floor(Date.now() / 1000 / targetSeconds) * targetSeconds - targetSeconds;
  const timestamps = [0, 1, 2, 3].map(index => bucketStart + index * 3600);
  const res = await requestMarket("BTC/USD", "H4", async () => ({
    ok: true,
    async json() { return yahooSeriesPayload(timestamps); }
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.payload.candles.length, 1);
  assert.equal(res.payload.candles[0].datetime, new Date(bucketStart * 1000).toISOString());
  assert.equal(res.payload.candles[0].open, 4200);
  assert.equal(res.payload.candles[0].high, 4213);
  assert.equal(res.payload.candles[0].low, 4187);
  assert.equal(res.payload.candles[0].close, 4208);
  assert.equal(res.payload.candles[0].volume, 406);
});

test("does not turn incomplete or gapped M45 Yahoo bars into a candle", async () => {
  const targetSeconds = 45 * 60;
  const bucketStart = Math.floor(Date.now() / 1000 / targetSeconds) * targetSeconds - targetSeconds;
  const res = await requestMarket("WTI", "M45", async () => ({
    ok: true,
    async json() { return yahooSeriesPayload([bucketStart, bucketStart + 1800]); }
  }));

  assert.equal(res.statusCode, 502);
  assert.match(res.payload.message, /candle/i);
});

test("does not publish a still-forming M45 bucket", async () => {
  const targetSeconds = 45 * 60;
  const bucketStart = Math.floor(Date.now() / 1000 / targetSeconds) * targetSeconds;
  const timestamps = [bucketStart, bucketStart + 900, bucketStart + 1800];
  const res = await requestMarket("WTI", "M45", async () => ({
    ok: true,
    async json() { return yahooSeriesPayload(timestamps); }
  }));

  assert.equal(res.statusCode, 502);
  assert.match(res.payload.message, /candle/i);
});

test("the first-visit splash screen has a working dashboard entry control", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  assert.ok(html.includes('<div id="aurumSplash" class="aurum-splash">'));
  assert.ok(html.includes('id="aurumEnterButton"'));
  assert.ok(html.includes("function enterDashboard()"));
  assert.ok(html.includes("enterButton.addEventListener('click', enterDashboard)"));
  assert.ok(html.includes("localStorage.setItem('aurumSplashSeen', 'true')"));
  assert.ok(html.includes('<section id="homePage" class="app-page active">'));
});


test("every visible navigation destination resolves to one unique app page", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const pageIds = [...html.matchAll(/<section\b[^>]*\bid=["']([^"']+)["'][^>]*class=["'][^"']*\bapp-page\b[^"']*["'][^>]*>/g)]
    .map(match => match[1]);
  const navTargets = [...html.matchAll(/data-page=["']([^"']+)["']/g)]
    .map(match => match[1]);
  assert.ok(pageIds.includes("homePage"));
  assert.ok(navTargets.length >= 6);
  assert.equal(new Set(pageIds).size, pageIds.length, "App page IDs must be unique");
  for (const target of navTargets) {
    assert.ok(pageIds.includes(target), "Navigation target has no app page: " + target);
  }
});

test("education tabs each point to an existing content panel and chat states its integration mode", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const guideTabs = [...html.matchAll(/data-guide-tab=["']([^"']+)["']/g)]
    .map(match => match[1]);
  assert.deepEqual(guideTabs, ["live", "lessons", "manual"]);
  for (const tab of guideTabs) {
    assert.ok(html.includes('id="aurumGuide' + tab[0].toUpperCase() + tab.slice(1) + '"'),
      "Missing education panel for tab: " + tab);
  }
  assert.ok(html.includes('id="aurumChatForm"'));
  assert.ok(html.includes("Asisten menggunakan aturan dan data server; tidak memerlukan layanan AI eksternal."));
});


test("health endpoint reports missing core configuration without exposing secrets", async () => {
  const names = ["CRON_SECRET", "KV_REST_API_URL", "KV_REST_API_TOKEN", "VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT", "NAIF_KEY", "TWELVE_DATA_API_KEY"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    const res = responseRecorder();
    await healthHandler({ method: 'GET' }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.status, "degraded");
    assert.equal(res.payload.checks.redis, "not_configured");
    assert.equal(res.payload.checks.cronSecret, false);
    assert.equal(JSON.stringify(res.payload).includes("Bearer"), false);
    assert.ok(res.payload.checkedAt);
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("health endpoint verifies Redis connectivity without returning credentials", async () => {
  const names = ["CRON_SECRET", "KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = global.fetch;
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.KV_REST_API_URL = "https://redis.example.test";
  process.env.KV_REST_API_TOKEN = "test-redis-token";
  global.fetch = async (_url, options) => {
    assert.equal(options.headers.Authorization, "Bearer test-redis-token");
    assert.equal(options.body, JSON.stringify(["PING"]));
    return { ok: true, async json() { return { result: "PONG" }; } };
  };
  try {
    const res = responseRecorder();
    await healthHandler({ method: 'GET' }, res);
    assert.equal(res.payload.status, "ok");
    assert.equal(res.payload.checks.redis, "connected");
    assert.equal(JSON.stringify(res.payload).includes("test-redis-token"), false);
    assert.equal(JSON.stringify(res.payload).includes("test-cron-secret"), false);
  } finally {
    global.fetch = originalFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("health endpoint rejects non-GET requests before checking Redis", async () => {
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("Redis must not be contacted for a rejected method");
  };
  try {
    const res = responseRecorder();
    await healthHandler({ method: 'POST' }, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.payload.message, "Method not allowed");
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
  }
});

test("health endpoint disables caching and marks market provider probe as pending", async () => {
  const names = ["CRON_SECRET", "KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  for (const name of names) delete process.env[name];
  try {
    const res = responseRecorder();
    await healthHandler({ method: 'GET' }, res);
    assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
    assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
    assert.equal(res.payload.checks.marketApi, "not_probed");
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});


test("cron endpoint rejects unauthorized requests without contacting external services", async () => {
  const cronHandler = require("../api/cron.js");
  const names = ["CRON_SECRET", "KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = global.fetch;
  process.env.CRON_SECRET = "test-cron-secret";
  process.env.KV_REST_API_URL = "https://redis.example.test";
  process.env.KV_REST_API_TOKEN = "test-redis-token";
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error("Unauthorized cron request must not call Redis or market APIs");
  };
  try {
    const res = responseRecorder();
    await cronHandler({ method: "POST", headers: { authorization: "Bearer wrong-secret" } }, res);
    assert.equal(res.statusCode, 401);
    assert.equal(res.payload.message, "Unauthorized");
    assert.equal(fetchCalled, false);
    assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
    assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
  } finally {
    global.fetch = originalFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("cron endpoint rejects unsupported methods with security headers", async () => {
  const cronHandler = require("../api/cron.js");
  const res = responseRecorder();
  await cronHandler({ method: "PUT", headers: {} }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
});

test("signals endpoint applies no-store and nosniff headers before method validation", async () => {
  const signalsHandler = require("../api/signals.js");
  const res = responseRecorder();
  await signalsHandler({ method: "POST" }, res);
  assert.equal(res.statusCode, 405);
  assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
  assert.equal(res.headers["X-Content-Type-Options"], "nosniff");
});


test("push subscriptions accept supported browser push services and valid keys", async () => {
  const handler = require("../api/push-subscribe.js");
  const names = ["KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = global.fetch;
  process.env.KV_REST_API_URL = "https://redis.example.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  const commands = [];
  global.fetch = async (_url, options) => {
    commands.push(JSON.parse(options.body));
    return { ok: true, async json() { return { result: "OK" }; } };
  };
  try {
    const res = responseRecorder();
    await handler({ method: "POST", body: {
      endpoint: "https://fcm.googleapis.com/fcm/send/test-token",
      keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) }
    } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.subscribed, true);
    assert.equal(commands.length, 2);
  } finally {
    global.fetch = originalFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("push subscriptions reject arbitrary HTTPS hosts before Redis writes", async () => {
  const handler = require("../api/push-subscribe.js");
  const names = ["KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = global.fetch;
  process.env.KV_REST_API_URL = "https://redis.example.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  let fetchCalled = false;
  global.fetch = async () => { fetchCalled = true; throw new Error("Redis must not be called"); };
  try {
    const res = responseRecorder();
    await handler({ method: "POST", body: {
      endpoint: "https://attacker.example/collect",
      keys: { p256dh: "A".repeat(87), auth: "B".repeat(22) }
    } }, res);
    assert.equal(res.statusCode, 400);
    assert.equal(fetchCalled, false);
  } finally {
    global.fetch = originalFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});

test("push unsubscription needs only a previously registered endpoint", async () => {
  const handler = require("../api/push-subscribe.js");
  const names = ["KV_REST_API_URL", "KV_REST_API_TOKEN"];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const originalFetch = global.fetch;
  process.env.KV_REST_API_URL = "https://redis.example.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  let calls = 0;
  global.fetch = async () => { calls++; return { ok: true, async json() { return { result: 1 }; } }; };
  try {
    const res = responseRecorder();
    await handler({ method: "DELETE", body: { endpoint: "https://fcm.googleapis.com/fcm/send/test-token" } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.subscribed, false);
    assert.equal(calls, 2);
  } finally {
    global.fetch = originalFetch;
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});


test("normalizes valid candle series in chronological order", () => {
  const candles = normalizeCandles([
    { datetime: "2026-11-25T10:02:00Z", open: 101, high: 104, low: 100, close: 103 },
    { datetime: "2026-11-25T10:01:00Z", open: 99, high: 102, low: 98, close: 101 }
  ]);
  assert.equal(candles.length, 2);
  assert.equal(candles[0].open, 99);
  assert.ok(candles[0].time < candles[1].time);
});

test("rejects the entire candle series when one OHLC bar is malformed", () => {
  const candles = normalizeCandles([
    { time: 1795600800, open: 100, high: 105, low: 99, close: 103 },
    { time: 1795600860, open: 103, high: 104, low: 106, close: 102 }
  ]);
  assert.deepEqual(candles, []);
});

test("rejects duplicate candle timestamps instead of creating false sequential bars", () => {
  const candles = normalizeCandles([
    { time: 1795600800, open: 100, high: 105, low: 99, close: 103 },
    { time: 1795600800, open: 103, high: 106, low: 101, close: 104 }
  ]);
  assert.deepEqual(candles, []);
});


test("rejects null or non-object candle rows without throwing", () => {
  assert.deepEqual(normalizeCandles([null]), []);
  assert.deepEqual(normalizeCandles(["not-a-candle"]), []);
});


test("signals endpoint skips a malformed current Redis record without failing all instruments", async () => {
  const signalsHandler = require("../api/signals.js");
  const originalFetch = global.fetch;
  const originalUrl = process.env.KV_REST_API_URL;
  const originalToken = process.env.KV_REST_API_TOKEN;
  process.env.KV_REST_API_URL = "https://redis.example.test";
  process.env.KV_REST_API_TOKEN = "test-token";
  let commandIndex = 0;
  global.fetch = async (_url, options) => {
    const command = JSON.parse(options.body);
    const isCurrentRead = command[0] === "GET";
    const result = isCurrentRead
      ? (commandIndex++ === 0 ? "{malformed-json" : null)
      : [];
    return { ok: true, json: async () => ({ result }) };
  };
  try {
    const res = responseRecorder();
    await signalsHandler({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.status, "success");
    assert.equal(res.payload.results.length, 3);
    assert.equal(res.payload.results[0].current, null);
  } finally {
    global.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = originalUrl;
    if (originalToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = originalToken;
  }
});


test("dashboard refresh keeps one status icon and handles chart fetch errors safely", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const homeStart = html.indexOf('<script id="aurum-home-live-ui">');
  const homeEnd = html.indexOf("</script>", homeStart);
  const chartStart = html.indexOf('<script id="aurum-setup-live-tick">');
  const chartEnd = html.indexOf("</script>", chartStart);
  assert.notEqual(homeStart, -1);
  assert.notEqual(homeEnd, -1);
  assert.notEqual(chartStart, -1);
  assert.notEqual(chartEnd, -1);
  const home = html.slice(homeStart, homeEnd);
  const chart = html.slice(chartStart, chartEnd);
  assert.ok(home.includes("if(!badge.querySelector('i'))"));
  assert.equal((home.match(/badge\.prepend\(dot\)/g) || []).length, 1);
  assert.ok(chart.includes("const symbol=pairEl.value||'XAU/USD';\n    try{"));
  assert.ok(chart.includes("if(pairEl.value===symbol"));
});

test("Aurum chat exposes the core ICT and risk-management learning topics", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const start = html.indexOf('<script id="aurum-chat-assistant">');
  const end = html.indexOf("</script>", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const chat = html.slice(start, end);
  for (const topic of [
    "market structure", "support", "choch", "liquidity sweep",
    "fair value gap", "order block", "break of structure",
    "inducement", "premium discount", "stop loss"
  ]) {
    assert.ok(chat.toLowerCase().includes(topic), "Missing chat topic: " + topic);
  }
  assert.ok(chat.includes("new RegExp('\\\\b'+x+'\\\\b','i')"));
  assert.ok(chat.includes("Saya belum memiliki jawaban terverifikasi"));
  assert.ok(!chat.includes("fetch('https://"));
});


test("fundamental page does not fabricate unavailable DXY, Treasury, news, or calendar data", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const start = html.indexOf('<section id="newsPage"');
  const end = html.indexOf("<!-- END HALAMAN BERITA -->", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const page = html.slice(start, end);
  assert.ok(page.includes('id="aurumFundamentalBroadUsd"'));
  assert.ok(page.includes("DTWEXBGS"));
  assert.ok(page.includes("bukan ICE DXY"));
  assert.ok(page.includes('id="aurumFundamentalUs10y"'));
  assert.ok(page.includes("DGS10"));
  assert.ok(html.includes("fetch('/api/fundamental'"));
  assert.match(page, /Belum ada penyedia berita ekonomi yang terhubung/);
  assert.match(page, /Kalender ekonomi belum terhubung ke penyedia data/);
  assert.ok(html.includes("fetch('/api/signals'"));
});

test("education page exposes all six core lessons and honest live-class availability", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const start = html.indexOf('<section id="guidePage"');
  const end = html.indexOf("<!-- END HALAMAN PANDUAN -->", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const page = html.slice(start, end);
  for (const title of [
    "Struktur Market", "Support &amp; Resistance", "Change of Character",
    "Liquidity Sweep", "Fair Value Gap", "Order Block"
  ]) assert.ok(page.includes(title), "Missing lesson: " + title);
  for (const tab of ["live", "lessons", "manual"]) {
    assert.ok(page.includes('data-guide-tab="' + tab + '"'));
  }
  assert.ok(page.includes("Kelas langsung belum dijadwalkan"));
  assert.ok(page.includes("Pemutar video AURUM baru dapat diaktifkan setelah sumber video asli tersedia"));
  assert.equal((page.match(/<details class="aurum-lesson-detail">/g) || []).length, 6);
  for (const concept of ["higher high", "higher low", "BOS", "CHOCH", "liquidity sweep", "Bullish FVG", "Bearish FVG", "displacement", "invalidasi"]) {
    assert.ok(page.toLowerCase().includes(concept.toLowerCase()), "Missing practical lesson detail: " + concept);
  }
  assert.ok(page.includes("<summary>Pelajari"));
});


test("fundamental endpoint exposes verified FRED macro observations with honest series labels", async () => {
  const fundamentalHandler = require("../api/fundamental.js");
  const originalFetch = global.fetch;
  globalThis.aurumFundamentalCache = null;
  const today = new Date().toISOString().slice(0, 10);
  global.fetch = async url => {
    const id = new URL(url).searchParams.get("id");
    return {
      ok: true,
      async text() {
        return id === "DGS10"
          ? "observation_date,DGS10\n" + today + ",4.25\n"
          : "observation_date,DTWEXBGS\n" + today + ",119.5\n";
      }
    };
  };
  try {
    const res = responseRecorder();
    await fundamentalHandler({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.status, "success");
    assert.equal(res.payload.results.us10y.value, 4.25);
    assert.equal(res.payload.results.us10y.unit, "%");
    assert.equal(res.payload.results.broadUsd.value, 119.5);
    assert.match(res.payload.results.broadUsd.note, /bukan ICE.*DXY/i);
    assert.equal(res.payload.results.broadUsd.seriesId, "DTWEXBGS");
    assert.equal(res.headers["Cache-Control"], "no-store, max-age=0");
  } finally {
    global.fetch = originalFetch;
    globalThis.aurumFundamentalCache = null;
  }
});

test("fundamental endpoint marks stale or invalid FRED observations unavailable", async () => {
  const fundamentalHandler = require("../api/fundamental.js");
  const originalFetch = global.fetch;
  globalThis.aurumFundamentalCache = null;
  const stale = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  global.fetch = async url => {
    const id = new URL(url).searchParams.get("id");
    return {
      ok: true,
      async text() {
        return id === "DGS10"
          ? "observation_date,DGS10\n" + stale + ",4.1\n"
          : "observation_date,DTWEXBGS\nnot-a-date,120\n";
      }
    };
  };
  try {
    const res = responseRecorder();
    await fundamentalHandler({ method: "GET" }, res);
    assert.equal(res.payload.results.us10y.status, "unavailable");
    assert.equal(res.payload.results.broadUsd.status, "unavailable");
    assert.equal(res.payload.status, "success");
  } finally {
    global.fetch = originalFetch;
    globalThis.aurumFundamentalCache = null;
  }
});

test("fundamental endpoint rejects non-GET requests without fetching FRED", async () => {
  const fundamentalHandler = require("../api/fundamental.js");
  const originalFetch = global.fetch;
  let called = false;
  global.fetch = async () => { called = true; throw new Error("Must not fetch"); };
  try {
    const res = responseRecorder();
    await fundamentalHandler({ method: "POST" }, res);
    assert.equal(res.statusCode, 405);
    assert.equal(res.payload.code, "METHOD_NOT_ALLOWED");
    assert.equal(res.headers.Allow, "GET");
    assert.equal(called, false);
  } finally {
    global.fetch = originalFetch;
  }
});


test("fundamental CSV parser skips missing values and rejects mismatched series headers", () => {
  const { parseLatestObservation } = require("../api/fundamental.js");
  assert.deepEqual(
    parseLatestObservation("observation_date,DGS10\n2026-11-20,.\n2026-11-21,4.31\n", "DGS10"),
    { date: "2026-11-21", value: 4.31 }
  );
  assert.equal(
    parseLatestObservation("observation_date,DTWEXBGS\n2026-11-21,119.5\n", "DGS10"),
    null
  );
  assert.equal(
    parseLatestObservation("observation_date,DGS10\n2026-02-30,4.2\n", "DGS10"),
    null
  );
});

test("fundamental endpoint keeps one valid macro series when the other provider request fails", async () => {
  const fundamentalHandler = require("../api/fundamental.js");
  const originalFetch = global.fetch;
  globalThis.aurumFundamentalCache = null;
  const today = new Date().toISOString().slice(0, 10);
  global.fetch = async url => {
    const id = new URL(url).searchParams.get("id");
    if (id === "DGS10") throw new Error("Temporary FRED timeout");
    return {
      ok: true,
      async text() { return "observation_date,DTWEXBGS\n" + today + ",118.7\n"; }
    };
  };
  try {
    const res = responseRecorder();
    await fundamentalHandler({ method: "GET" }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.results.us10y.status, "unavailable");
    assert.equal(res.payload.results.broadUsd.status, "available");
    assert.equal(res.payload.results.broadUsd.value, 118.7);
  } finally {
    global.fetch = originalFetch;
    globalThis.aurumFundamentalCache = null;
  }
});

test("fundamental endpoint rejects future-dated observations", async () => {
  const fundamentalHandler = require("../api/fundamental.js");
  const originalFetch = global.fetch;
  globalThis.aurumFundamentalCache = null;
  const future = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  global.fetch = async url => {
    const id = new URL(url).searchParams.get("id");
    return {
      ok: true,
      async text() {
        return "observation_date," + id + "\n" + future + ",4.2\n";
      }
    };
  };
  try {
    const res = responseRecorder();
    await fundamentalHandler({ method: "GET" }, res);
    assert.equal(res.payload.results.us10y.status, "unavailable");
    assert.equal(res.payload.results.broadUsd.status, "unavailable");
  } finally {
    global.fetch = originalFetch;
    globalThis.aurumFundamentalCache = null;
  }
});


test("chart refresh failure marks the visible feed delayed instead of leaving a live-looking timestamp", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const start = html.indexOf('<script id="aurum-setup-live-tick">');
  const end = html.indexOf("</script>", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const chart = html.slice(start, end);
  const catchStart = chart.indexOf("}catch(e){");
  const catchEnd = chart.indexOf("console.warn('AURUM setup live tick:',e);", catchStart);
  assert.notEqual(catchStart, -1);
  assert.notEqual(catchEnd, -1);
  const failureState = chart.slice(catchStart, catchEnd);
  assert.ok(failureState.includes("PEMBARUAN GAGAL"));
  assert.ok(failureState.includes("DATA TERTUNDA"));
  assert.ok(failureState.includes("marketState.dataset.state='delayed'"));
});


test("education tabs connect live class, lesson catalog, and app manual panels", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const start = html.indexOf('<script id="aurum-traxa-parity-behavior">');
  const end = html.indexOf("</script>", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const behavior = html.slice(start, end);
  for (const key of ["live", "lessons", "manual"]) {
    assert.ok(html.includes('data-guide-tab="' + key + '"'));
    assert.ok(behavior.includes("$('aurumGuide" + (key === "live" ? "Live" : key === "lessons" ? "Lessons" : "Manual") + "')"));
  }
  assert.ok(behavior.includes("document.querySelectorAll('[data-guide-tab]').forEach"));
  assert.ok(behavior.includes("x.setAttribute('aria-selected',active?'true':'false')"));
  assert.ok(behavior.includes(".hidden=key!=="));
});

test("chat form and suggested prompts are wired to the same local assistant", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const start = html.indexOf('<script id="aurum-chat-assistant">');
  const end = html.indexOf("</script>", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const chat = html.slice(start, end);
  assert.ok(chat.includes("form.addEventListener('submit'"));
  assert.ok(chat.includes("document.querySelectorAll('[data-aurum-chat-prompt]')"));
  assert.ok(chat.includes("send(b.getAttribute('data-aurum-chat-prompt'))"));
  assert.ok(chat.includes("async function send(q)"));
  assert.ok(chat.includes("Saya belum memiliki jawaban terverifikasi"));
  assert.ok(!chat.includes("fetch('https://"));
});




test("splash entry survives browsers that deny localStorage access", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const start = html.indexOf("<!-- AURUM SPLASH SCREEN INTERACTION -->");
  const end = html.indexOf("<!-- END AURUM SPLASH SCREEN INTERACTION -->", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const splash = html.slice(start, end);
  assert.ok(splash.includes("let splashAlreadySeen = false"));
  assert.ok(splash.includes("splashAlreadySeen = localStorage.getItem('aurumSplashSeen') === 'true'"));
  assert.ok(splash.includes("localStorage.setItem('aurumSplashSeen', 'true')"));
  assert.ok(splash.includes("The splash still closes for this visit"));
});

test("market directory selection uses the shared router to keep page, URL, and active tab synchronized", () => {
  const html = fs.readFileSync(require.resolve("../public/index.html"), "utf8");
  const start = html.indexOf("document.getElementById('aurumMarketDirectory')?.addEventListener('click'");
  const end = html.indexOf("document.getElementById('aurumSignalDetailBack').addEventListener", start);
  assert.notEqual(start, -1, "Market directory click handler must exist");
  assert.notEqual(end, -1, "Market directory handler must end before signal detail back handler");
  const handler = html.slice(start, end);
  assert.ok(handler.includes("window.aurumShowPage('marketPage')"),
    "Instrument selection must use the shared page router");
  assert.ok(handler.indexOf("window.aurumShowPage('marketPage')") < handler.indexOf("} else {"),
    "The shared router must be the primary navigation path");
  assert.ok(handler.includes("pairSelect.dispatchEvent(new Event('change'"),
    "Selecting an instrument must update the active market data feed");
  assert.equal((html.match(/document.getElementById\('aurumMarketDirectory'\)\?\.addEventListener\('click'/g) || []).length, 1,
    "The market directory must have one delegated click handler, not duplicate handlers");
  assert.ok(!html.includes('id="aurum-market-directory-actions"'),
    "The obsolete per-row market handler must be removed");
});
