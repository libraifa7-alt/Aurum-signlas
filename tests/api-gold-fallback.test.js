const test = require("node:test");
const assert = require("node:assert/strict");
const handler = require("../api/index.js");

function makeResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() { return payload; }
  };
}

test("stale XAUS Gold candles fall back to fresh BiQuote MT5 bars", async () => {
  const originalFetch = global.fetch;
  const originalRedisUrl = process.env.KV_REST_API_URL;
  const originalRedisToken = process.env.KV_REST_API_TOKEN;
  const originalTwelveKey = process.env.TWELVE_DATA_API_KEY;
  const now = Date.now();
  const nowMinute = Math.floor(now / 60000) * 60000;
  const calls = [];

  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  delete process.env.TWELVE_DATA_API_KEY;
  globalThis.aurumCache = new Map();

  global.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.hostname + url.pathname);

    if (url.hostname === "xaus.com" && url.pathname === "/api/v1/spot") {
      return makeResponse(200, {
        spot_usd_oz: 4200,
        updated_at: new Date(now).toISOString(),
        stale: false,
        data_state: { status: "fresh" }
      });
    }

    if (url.hostname === "xaus.com" && url.pathname === "/api/v1/chart") {
      return makeResponse(200, {
        points: [{
          t: Math.floor((now - 10 * 60 * 1000) / 1000),
          o: 4190, h: 4192, l: 4189, c: 4191, v: 10
        }]
      });
    }

    if (url.hostname === "biquote.io" && url.pathname === "/api/XAUUSD/ohlc") {
      return makeResponse(200, {
        symbol: "XAUUSD",
        interval: "1m",
        bars: [
          {
            openTime: new Date(nowMinute - 60000).toISOString(),
            open: 4200, high: 4202, low: 4199, close: 4201,
            tickVolume: 25, isOpen: false
          },
          {
            openTime: new Date(nowMinute).toISOString(),
            open: 4201, high: 4203, low: 4200, close: 4202,
            tickVolume: 2, isOpen: true
          }
        ]
      });
    }

    if (url.hostname === "biquote.io" && url.pathname === "/api/XAUUSD") {
      return makeResponse(200, {
        symbol: "XAUUSD",
        mid: 4201.5,
        timestamp: new Date(now).toISOString(),
        source: "MetaTrader 5 (Broker 1)",
        marketState: "open",
        stale: false
      });
    }

    throw new Error("Unexpected provider request: " + url.toString());
  };

  try {
    const res = {
      statusCode: null,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; }
    };

    await handler({ query: { symbol: "XAU/USD", interval: "M1" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.status, "success");
    assert.equal(res.payload.candleSource, "BiQuote MT5");
    assert.equal(res.payload.candleStatus, "fresh_candles");
    assert.equal(res.payload.livePrice, 4201.5);
    assert.equal(res.payload.livePriceStatus, "live_quote");
    assert.equal(res.payload.candles.length, 1, "open/incomplete bar must be excluded");
    assert.equal(res.payload.candles[0].close, 4201);
    assert.ok(calls.includes("biquote.io/api/XAUUSD/ohlc"));
    assert.ok(calls.includes("biquote.io/api/XAUUSD"));
    assert.ok(!calls.some(call => call.includes("twelvedata.com")), "fresh BiQuote data should avoid Twelve Data quota");
  } finally {
    global.fetch = originalFetch;
    if (originalRedisUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = originalRedisUrl;
    if (originalRedisToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = originalRedisToken;
    if (originalTwelveKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveKey;
    globalThis.aurumCache = new Map();
  }
});


test("stale BiQuote response falls through to Twelve Data instead of being marked live", async () => {
  const originalFetch = global.fetch;
  const originalRedisUrl = process.env.KV_REST_API_URL;
  const originalRedisToken = process.env.KV_REST_API_TOKEN;
  const originalTwelveKey = process.env.TWELVE_DATA_API_KEY;
  const now = Date.now();
  const lastClosed = new Date(Math.floor(now / 60000) * 60000 - 60000).toISOString();
  const calls = [];

  delete process.env.KV_REST_API_URL;
  delete process.env.KV_REST_API_TOKEN;
  process.env.TWELVE_DATA_API_KEY = "test-key";
  globalThis.aurumCache = new Map();

  global.fetch = async (input) => {
    const url = new URL(String(input));
    calls.push(url.hostname + url.pathname);

    if (url.hostname === "xaus.com" && url.pathname === "/api/v1/spot") {
      return makeResponse(200, {
        spot_usd_oz: 4200,
        updated_at: new Date(now).toISOString(),
        stale: false,
        data_state: { status: "fresh" }
      });
    }

    if (url.hostname === "xaus.com" && url.pathname === "/api/v1/chart") {
      return makeResponse(200, {
        points: [{
          t: Math.floor((now - 10 * 60 * 1000) / 1000),
          o: 4190, h: 4192, l: 4189, c: 4191, v: 10
        }]
      });
    }

    if (url.hostname === "biquote.io" && url.pathname === "/api/XAUUSD/ohlc") {
      return makeResponse(503, { message: "BiQuote temporarily unavailable" });
    }

    if (url.hostname === "biquote.io" && url.pathname === "/api/XAUUSD") {
      return makeResponse(404, { message: "No fresh tick" });
    }

    if (url.hostname === "api.twelvedata.com" && url.pathname === "/time_series") {
      return makeResponse(200, {
        status: "ok",
        values: [{
          datetime: lastClosed,
          open: "4200.00",
          high: "4202.00",
          low: "4199.00",
          close: "4201.00",
          volume: "0"
        }]
      });
    }

    if (url.hostname === "api.twelvedata.com" && url.pathname === "/price") {
      return makeResponse(200, { price: "4201.25" });
    }

    throw new Error("Unexpected provider request: " + url.toString());
  };

  try {
    const res = {
      statusCode: null,
      payload: null,
      status(code) { this.statusCode = code; return this; },
      json(payload) { this.payload = payload; return this; }
    };

    await handler({ query: { symbol: "XAU/USD", interval: "M1" } }, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.payload.status, "success");
    assert.equal(res.payload.candleSource, "Twelve Data");
    assert.equal(res.payload.candleStatus, "fresh_candles");
    assert.equal(res.payload.livePrice, 4201.25);
    assert.equal(res.payload.livePriceStatus, "live_quote");
    assert.ok(calls.includes("biquote.io/api/XAUUSD/ohlc"));
    assert.ok(calls.includes("api.twelvedata.com/time_series"));
  } finally {
    global.fetch = originalFetch;
    if (originalRedisUrl === undefined) delete process.env.KV_REST_API_URL;
    else process.env.KV_REST_API_URL = originalRedisUrl;
    if (originalRedisToken === undefined) delete process.env.KV_REST_API_TOKEN;
    else process.env.KV_REST_API_TOKEN = originalRedisToken;
    if (originalTwelveKey === undefined) delete process.env.TWELVE_DATA_API_KEY;
    else process.env.TWELVE_DATA_API_KEY = originalTwelveKey;
    globalThis.aurumCache = new Map();
  }
});
