const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/index.js");
const fs = require("node:fs");

function responseRecorder() {
  return {
    statusCode: 200,
    payload: null,
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
    await handler({ query: { symbol, interval } }, res);
    return res;
  } finally {
    global.fetch = originalFetch;
  }
}

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

test("marks recent Yahoo BTC candles fresh from their actual timestamp", async () => {
  const timestamp = Math.floor(Date.now() / 1000) - 60;
  const res = await requestMarket("BTC/USD", "M1", async () => ({
    ok: true,
    async json() { return yahooPayload(timestamp); }
  }));

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
