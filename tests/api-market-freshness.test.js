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
  assert.match(html, /const signalDataIsFresh[\\s\\S]*?chartFeedMeta\\?\\.candleStatus === 'fresh_candles'/);
  assert.doesNotMatch(html, /pair[^;]{0,100}!== 'XAU\\/USD'[\\s\\S]{0,100}candleStatus/);
});
