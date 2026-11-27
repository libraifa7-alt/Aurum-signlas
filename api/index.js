

module.exports = async function handler(req, res) {
  const env = req.env || process.env;
  if (typeof res.setHeader === "function") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  if (req.method && req.method !== "GET") {
    if (typeof res.setHeader === "function") res.setHeader("Allow", "GET");
    return res.status(405).json({
      status: "error",
      code: "METHOD_NOT_ALLOWED",
      message: "Market data endpoint hanya menerima GET"
    });
  }

  if (!globalThis.aurumCache) {
    globalThis.aurumCache = new Map();
  }

  // AURUM REDIS CONNECTION
  async function aurumRedis(command) {
    const redisUrl = String(env.KV_REST_API_URL || '').trim().replace(/^['\"]|['\"]$/g, '');
    const redisToken = String(env.KV_REST_API_TOKEN || '').trim().replace(/^['\"]|['\"]$/g, '');

    if (!redisUrl || !redisToken) {
      return null;
    }
    const parsedRedisUrl = new URL(redisUrl);
    if (parsedRedisUrl.protocol !== 'https:') {
      throw new Error('Redis REST URL must use HTTPS');
    }

    const response = await fetch(redisUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + redisToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command),
      signal: AbortSignal.timeout(8000)
    });

    const result = await response.json();

    if (!response.ok || result.error) {
      throw new Error(
        result.error || "Redis connection failed"
      );
    }

    return result.result;
  }
  // END AURUM REDIS CONNECTION

  const allowedIntervals = {
    M1: "1min",
    M5: "5min",
    M15: "15min",
    M30: "30min",
    M45: "45min",
    H1: "1h",
    H4: "4h",
    D1: "1day"
  };

  const selectedSymbol = String(
    req.query.symbol || "XAU/USD"
  ).toUpperCase();

  const selected = String(
    req.query.interval || "M15"
  ).toUpperCase();

  // Restrict provider access to the instruments actually supported by Aurum.
  // Arbitrary symbols could consume the configured market-data quota.
  const allowedSymbols = new Set(["XAU/USD", "BTC/USD", "WTI"]);
  if (!allowedSymbols.has(selectedSymbol)) {
    return res.status(400).json({
      status: "error",
      code: "INVALID_SYMBOL",
      message: "Instrumen tidak didukung",
      receivedSymbol: selectedSymbol
    });
  }

  if (!Object.prototype.hasOwnProperty.call(allowedIntervals, selected)) {
    return res.status(400).json({
      status: "error",
      code: "INVALID_INTERVAL",
      message: "Interval tidak valid",
      receivedInterval: selected
    });
  }

  const interval = allowedIntervals[selected];
  const debugRaw = req.query.debug === "raw" && selectedSymbol === "XAU/USD";
  const debugQuote = req.query.debug === "quote" && selectedSymbol === "XAU/USD";

  // Versioned provider cache prevents old MarketAPI candles being reused.
  const cacheSource = "yahoo";
  const cacheKey = selectedSymbol + ":" + interval + ":" + cacheSource + ((selectedSymbol === "XAU/USD" || selectedSymbol === "WTI" || selectedSymbol === "BTC/USD") ? ":v3" : ":v2");
  const cached = globalThis.aurumCache.get(cacheKey);

  // Recalculate BTC/WTI candle freshness from the candle timestamps on every
  // response. A recent fetch/cache write must never make old candles look live.
  function withYahooCandleFreshness(payload, cacheLabel) {
    if (!payload) {
      return payload;
    }

    const candles = Array.isArray(payload.candles) ? payload.candles : [];
    const newest = candles.reduce((latest, candle) => {
      const candidateTime = Date.parse(candle?.datetime || "");
      const latestTime = Date.parse(latest?.datetime || "");
      return Number.isFinite(candidateTime) && (!Number.isFinite(latestTime) || candidateTime > latestTime)
        ? candle
        : latest;
    }, null);
    const lastCandleAt = newest?.datetime || payload.lastCandleAt || null;
    const rawAgeSeconds = lastCandleAt
      ? Math.floor((Date.now() - Date.parse(lastCandleAt)) / 1000)
      : NaN;
    const freshnessLimit = ({
      M1: 300,
      M5: 900,
      M15: 2700,
      M30: 5400,
      M45: 8100,
      H1: 10800,
      H4: 43200,
      D1: 259200
    }[selected] || 2700);
    const fresh = candles.length > 0 &&
      Number.isFinite(rawAgeSeconds) &&
      rawAgeSeconds >= -60 &&
      rawAgeSeconds <= freshnessLimit;

    return {
      ...payload,
      lastCandleAt,
      candleAgeSeconds: Number.isFinite(rawAgeSeconds) ? Math.max(0, rawAgeSeconds) : null,
      candleStatus: fresh ? "fresh_candles" : "stale_candles",
      ...(cacheLabel ? { cache: cacheLabel } : {})
    };
  }

  // AURUM SMART API CACHE OPTIMIZATION
  const cacheTTL = 60000;

  if (cached && Date.now() - cached.time < cacheTTL) {
    return res.status(200).json(withYahooCandleFreshness(cached.data, "memory"));
  }

    try {

    // AURUM REDIS CACHE READ
    const redisKey = "aurum:candles:" + cacheKey;

    let redisCached = null;

    try {
      const redisData = await aurumRedis([
        "GET",
        redisKey
      ]);

      if (redisData) {
        redisCached = JSON.parse(redisData);
      }
    } catch (redisError) {
      console.error(
        "REDIS READ ERROR:",
        redisError.message
      );
    }

    
    // GUNAKAN CACHE REDIS JIKA MASIH SEGAR
    if (redisCached && redisCached.data) {
      globalThis.aurumCache.set(cacheKey, {
        time: redisCached.time,
        data: redisCached.data
      });

      if (Date.now() - redisCached.time < cacheTTL) {
        return res.status(200).json(withYahooCandleFreshness(redisCached.data, "redis"));
      }
    }


    // Semua aset kini menggunakan jalur Yahoo Finance yang sama.

    // Satu jalur Yahoo Finance untuk Gold, BTC, dan WTI.
    if (selectedSymbol === "XAU/USD" || selectedSymbol === "WTI" || selectedSymbol === "BTC/USD") {
      const yahooSymbol = selectedSymbol === "XAU/USD" ? "GC=F" : selectedSymbol === "WTI" ? "CL=F" : "BTC-USD";
      const assetLabel = selectedSymbol === "XAU/USD" ? "Gold (COMEX futures)" : selectedSymbol === "WTI" ? "WTI" : "BTC/USD";
      const yahooIntervals = {
        M1: "1m",
        M5: "5m",
        M15: "15m",
        M30: "30m",
        H1: "60m",
        H4: "60m",
        D1: "1d"
      };

      
      const yahooInterval = yahooIntervals[
        selected === "M45" ? "M15" : selected
      ] || "15m";

      const url = new URL(
        `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol)}`
      );

      const yahooRanges = {
        M1: "5d",
        M5: "1mo",
        M15: "1mo",
        M30: "1mo",
        M45: "1mo",
        H1: "1mo",
        H4: "3mo",
        D1: "1y"
      };

      url.searchParams.set(
        "range",
        yahooRanges[selected] || "5d"
      );

      url.searchParams.set("interval", yahooInterval);

      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0"
        },
        signal: AbortSignal.timeout(12000)
      });

      const data = await response.json();
      const result = data.chart?.result?.[0];

      if (!response.ok || !result) {
        if (redisCached && redisCached.data) {
          return res.status(200).json(
            withYahooCandleFreshness(redisCached.data, "stale_fallback")
          );
        }

        return res.status(502).json({
          status: "error",
          message:
            data.chart?.error?.description ||
            `Gagal mengambil data ${assetLabel} dari Yahoo Finance`
        });
      }

      const timestamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0];

      if (!quote) {
        if (redisCached && redisCached.data) {
          return res.status(200).json(
            withYahooCandleFreshness(redisCached.data, "stale_fallback")
          );
        }

        return res.status(502).json({
          status: "error",
          message: `Data candle ${assetLabel} tidak tersedia`
        });
      }

      let candles = timestamps.map((timestamp, i) => {
        const timestampMs = Number(timestamp) * 1000;
        const rawOpen = quote.open?.[i];
        const rawHigh = quote.high?.[i];
        const rawLow = quote.low?.[i];
        const rawClose = quote.close?.[i];
        if (rawOpen == null || rawHigh == null || rawLow == null || rawClose == null) {
          return null;
        }
        const open = Number(rawOpen);
        const high = Number(rawHigh);
        const low = Number(rawLow);
        const close = Number(rawClose);

        if (
          !Number.isFinite(timestampMs) ||
          timestampMs <= 0 ||
          timestampMs > Date.now() + 60000 ||
          !Number.isFinite(open) ||
          !Number.isFinite(high) ||
          !Number.isFinite(low) ||
          !Number.isFinite(close) ||
          high < Math.max(open, close, low) ||
          low > Math.min(open, close, high)
        ) {
          return null;
        }

        return {
          datetime: new Date(timestampMs).toISOString(),
          open,
          high,
          low,
          close,
          volume: Number(quote.volume?.[i]) || 0
        };
      }).filter(Boolean);

      // Build complete M45/H4 candles only from consecutive, closed Yahoo bars.
      // This prevents partial or gapped provider bars from becoming false signals.
      if (selected === "M45" || selected === "H4") {
        const sourceSeconds = selected === "M45" ? 15 * 60 : 60 * 60;
        const targetSeconds = selected === "M45" ? 45 * 60 : 4 * 60 * 60;
        const expectedBars = targetSeconds / sourceSeconds;
        const buckets = new Map();
        const nowMs = Date.now();

        for (const candle of candles) {
          const candleSeconds = Math.floor(Date.parse(candle.datetime) / 1000);
          if (!Number.isFinite(candleSeconds)) continue;

          const bucketStart = Math.floor(candleSeconds / targetSeconds) * targetSeconds;
          const offset = candleSeconds - bucketStart;
          if (offset < 0 || offset >= targetSeconds || offset % sourceSeconds !== 0) continue;

          const bucket = buckets.get(bucketStart) || [];
          bucket.push(candle);
          buckets.set(bucketStart, bucket);
        }

        candles = Array.from(buckets.entries())
          .sort((a, b) => a[0] - b[0])
          .filter(([bucketStart, group]) => {
            if (group.length !== expectedBars) return false;
            if ((bucketStart + targetSeconds) * 1000 > nowMs) return false;

            group.sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));
            return group.every((candle, index) =>
              Date.parse(candle.datetime) === (bucketStart + index * sourceSeconds) * 1000
            );
          })
          .map(([bucketStart, group]) => ({
            datetime: new Date(bucketStart * 1000).toISOString(),
            open: group[0].open,
            high: Math.max(...group.map(candle => candle.high)),
            low: Math.min(...group.map(candle => candle.low)),
            close: group[group.length - 1].close,
            volume: group.reduce((sum, candle) => sum + candle.volume, 0)
          }));
      }

      // Urutkan berdasarkan waktu dan kirim hanya candle paling baru.
      // Yahoo 1m membatasi riwayat intraday; range 5d menjaga jendela tetap valid.
      candles.sort((a, b) => Date.parse(a.datetime) - Date.parse(b.datetime));

      const targetBars = selected === "M45" ? 300 : 100;
      candles = candles.slice(-targetBars);

      if (!candles.length) {
        return res.status(502).json({
          status: "error",
          message: `Yahoo Finance tidak mengirim candle ${assetLabel} yang valid`
        });
      }

      // HASIL DATA WTI + penanda waktu agar kesegaran data dapat diperiksa.
      const yahooMeta = result.meta || {};
      const quoteTimestamp = Number(yahooMeta.regularMarketTime) * 1000;
      const quoteAgeSeconds = Number.isFinite(quoteTimestamp) ? Math.floor((Date.now() - quoteTimestamp) / 1000) : Infinity;
      const liveQuoteFresh = Number.isFinite(Number(yahooMeta.regularMarketPrice)) && Number(yahooMeta.regularMarketPrice) > 0 && quoteAgeSeconds >= -60 && quoteAgeSeconds <= 180;
      const output = withYahooCandleFreshness({
        status: "success",
        symbol: selectedSymbol,
        interval: selected,
        source: `Yahoo Finance (${yahooSymbol})`,
        candleSource: `Yahoo Finance ${yahooSymbol}` + (selectedSymbol === "XAU/USD" ? " (COMEX gold futures proxy, bukan spot)" : ""),
        providerFetchedAt: new Date().toISOString(),
        lastCandleAt: candles[candles.length - 1].datetime,
        livePrice: liveQuoteFresh ? Number(yahooMeta.regularMarketPrice) : null,
        livePriceUpdatedAt: liveQuoteFresh ? new Date(quoteTimestamp).toISOString() : null,
        livePriceSource: `Yahoo Finance (${yahooSymbol})`,
        livePriceStatus: liveQuoteFresh ? "live_quote" : "quote_unavailable",
        livePriceError: liveQuoteFresh ? null : "Yahoo Finance tidak menyediakan kuotasi pasar yang cukup baru",
        candles
      });

      // SIMPAN KE MEMORY CACHE
      globalThis.aurumCache.set(cacheKey, {
        time: Date.now(),
        data: output
      });

      // SIMPAN KE REDIS SELAMA 7 HARI
      try {
        await aurumRedis([
          "SET",
          redisKey,
          JSON.stringify({
            time: Date.now(),
            data: output
          }),
          "EX",
          "604800"
        ]);
      } catch (redisError) {
        console.error(
          "REDIS WRITE ERROR:",
          redisError.message
        );
      }

      return res.status(200).json(output);
    }
      


    // JALUR DATA XAU/USD DAN BTC/USD DARI TWELVE DATA

// JALUR DATA XAU/USD DAN BTC/USD DARI TWELVE DATA

const twelveApiKey = env.TWELVE_DATA_API_KEY;

if (!twelveApiKey) {
  if (redisCached && redisCached.data) {
    return res.status(200).json({
      ...redisCached.data,
      cache: "stale"
    });
  }

  return res.status(500).json({
    status: "error",
    message: "TWELVE_DATA_API_KEY belum diatur"
  });
}

async function getCachedGoldQuote() {
  const quoteKey = "aurum:quote:XAUUSD:v1";
  const errorKey = "aurum:quote-error:XAUUSD:v1";
  let saved = null;
  let savedError = null;

  try {
    const raw = await aurumRedis(["GET", quoteKey]);
    if (raw) saved = JSON.parse(raw);
  } catch (error) {
    console.warn("AURUM GOLD QUOTE CACHE READ:", error.message);
  }

  const ageMs = saved?.receivedAt ? Date.now() - Date.parse(saved.receivedAt) : Infinity;
  if (saved && Number.isFinite(Number(saved.price)) && ageMs >= 0 && ageMs < 60000) {
    return {
      price: Number(saved.price),
      updatedAt: saved.receivedAt,
      source: "Twelve Data /price",
      status: "live_quote",
      cache: "redis_quote",
      error: null
    };
  }

  try {
    const rawError = await aurumRedis(["GET", errorKey]);
    if (rawError) savedError = JSON.parse(rawError);
  } catch (error) {
    console.warn("AURUM GOLD QUOTE ERROR CACHE READ:", error.message);
  }

  const errorAge = savedError?.receivedAt ? Date.now() - Date.parse(savedError.receivedAt) : Infinity;
  if (savedError && errorAge >= 0 && errorAge < 300000) {
    return {
      price: saved && Number.isFinite(Number(saved.price)) ? Number(saved.price) : null,
      updatedAt: saved?.receivedAt || null,
      source: "Twelve Data /price",
      status: saved ? "stale_quote" : "quote_unavailable",
      cache: saved ? "redis_stale_quote" : "negative_cache",
      error: savedError.message || "Kuotasi sementara tidak tersedia"
    };
  }

  try {
    const priceUrl = new URL("https://api.twelvedata.com/price");
    priceUrl.searchParams.set("symbol", "XAU/USD");
    priceUrl.searchParams.set("apikey", twelveApiKey);
    const response = await fetch(priceUrl, { cache: "no-store" });
    const payload = await response.json();
    const price = Number(payload.price);

    if (response.ok && Number.isFinite(price) && price > 0) {
      const record = { price, receivedAt: new Date().toISOString() };
      try {
        await aurumRedis(["SET", quoteKey, JSON.stringify(record), "EX", "86400"]);
        await aurumRedis(["DEL", errorKey]);
      } catch (error) {
        console.warn("AURUM GOLD QUOTE CACHE WRITE:", error.message);
      }
      return {
        price,
        updatedAt: record.receivedAt,
        source: "Twelve Data /price",
        status: "live_quote",
        cache: "provider",
        error: null
      };
    }

    const message = String(payload.message || payload.code || "Twelve Data tidak mengirim kuotasi").slice(0, 180);
    try {
      await aurumRedis(["SET", errorKey, JSON.stringify({ message, receivedAt: new Date().toISOString() }), "EX", "300"]);
    } catch (error) {
      console.warn("AURUM GOLD QUOTE ERROR CACHE WRITE:", error.message);
    }
    return {
      price: saved && Number.isFinite(Number(saved.price)) ? Number(saved.price) : null,
      updatedAt: saved?.receivedAt || null,
      source: "Twelve Data /price",
      status: saved ? "stale_quote" : "quote_unavailable",
      cache: saved ? "redis_stale_quote" : "provider_error",
      error: message
    };
  } catch (error) {
    const message = String(error.message || "Gagal mengambil kuotasi").slice(0, 180);
    try {
      await aurumRedis(["SET", errorKey, JSON.stringify({ message, receivedAt: new Date().toISOString() }), "EX", "300"]);
    } catch (_) {}
    return {
      price: saved && Number.isFinite(Number(saved.price)) ? Number(saved.price) : null,
      updatedAt: saved?.receivedAt || null,
      source: "Twelve Data /price",
      status: saved ? "stale_quote" : "quote_error",
      cache: saved ? "redis_stale_quote" : "request_error",
      error: message
    };
  }
}

async function respondWithStaleCache() {
  const fallback = {
    ...redisCached.data,
    cache: "stale_candles"
  };

  if (selectedSymbol === "XAU/USD") {
    const quote = await getCachedGoldQuote();
    fallback.livePrice = quote.price;
    fallback.livePriceUpdatedAt = quote.updatedAt;
    fallback.livePriceSource = quote.source;
    fallback.livePriceStatus = quote.status;
    fallback.livePriceError = quote.error;
    if (quote.price !== null) {
      // Keep provider OHLC unchanged. The live quote is exposed separately.
      fallback.cache = "stale_candles_" + quote.cache;
    }
  }

  return res.status(200).json(fallback);
}

// Safe diagnostic for the Gold quote endpoint; never returns the API key.
if (debugQuote) {
  const quote = await getCachedGoldQuote();
  return res.status(200).json({
    status: quote.price !== null ? "success" : "provider_error",
    diagnostic: "xauusd_price_endpoint",
    symbol: selectedSymbol,
    price: quote.price,
    receivedAt: quote.updatedAt,
    quoteStatus: quote.status,
    quoteCache: quote.cache,
    providerMessage: quote.error
  });
}

// Twelve Data supports 45min directly; request the selected interval.
const providerInterval = interval;
const outputsize = selected === "M45" ? 300 : 100;

// REQUEST TWELVE DATA
const twelveUrl = new URL(
  "https://api.twelvedata.com/time_series"
);

twelveUrl.searchParams.set("symbol", selectedSymbol);
twelveUrl.searchParams.set("interval", providerInterval);
twelveUrl.searchParams.set("outputsize", String(outputsize));
twelveUrl.searchParams.set("timezone", "UTC");
twelveUrl.searchParams.set("order", "ASC");
twelveUrl.searchParams.set("apikey", twelveApiKey);

// AMBIL DAN VALIDASI DATA
const twelveResponse = await fetch(twelveUrl);
const twelveData = await twelveResponse.json();

if (
  !twelveResponse.ok ||
  twelveData.status === "error" ||
  !Array.isArray(twelveData.values)
) {
  console.error(
    "AURUM TWELVE DATA ERROR:",
    twelveData
  );

  try {
    const providerErrorRecord = JSON.stringify({
      message: String(twelveData.message || twelveData.code || "Twelve Data request failed").slice(0, 180),
      receivedAt: new Date().toISOString()
    });
    await aurumRedis(["SET", providerErrorKey, providerErrorRecord, "EX", "300"]);
    await aurumRedis(["SET", globalProviderErrorKey, providerErrorRecord, "EX", "300"]);
  } catch (error) {
    console.warn("AURUM PROVIDER COOLDOWN WRITE:", error.message);
  }

  if (redisCached && redisCached.data) {
    return await respondWithStaleCache();
  }

  return res.status(502).json({
    status: "error",
    message:
      twelveData.message ||
      "Gagal mengambil data Twelve Data"
  });
}

// DIAGNOSTIK RAW TWELVE DATA XAU/USD — LEWATI CACHE, TANPA MEMBUKA API KEY
if (debugRaw) {
  const values = twelveData.values;
  const opens = values.map(c => Number(c.open));
  const uniqueOpens = new Set(opens.filter(Number.isFinite));
  return res.status(200).json({
    status: "success",
    diagnostic: "raw_twelve_data",
    symbol: selectedSymbol,
    requestedInterval: selected,
    providerInterval,
    providerMeta: twelveData.meta || null,
    totalCandles: values.length,
    distinctOpenValues: uniqueOpens.size,
    firstCandles: values.slice(0, 5),
    lastCandles: values.slice(-5)
  });
}

// KONVERSI FORMAT TWELVE DATA KE FORMAT AURUM
const convertedCandles = twelveData.values
  .map(c => {
    const datetime = String(c.datetime || "");
    const normalizedTime = datetime.includes("T")
      ? datetime
      : datetime.replace(" ", "T");

    return {
      time: normalizedTime.endsWith("Z")
        ? normalizedTime
        : normalizedTime + "Z",
      open: Number(c.open),
      high: Number(c.high),
      low: Number(c.low),
      close: Number(c.close),
      tick_volume: Number(c.volume || 0)
    };
  })
  .filter(c =>
    c.time &&
    Number.isFinite(Date.parse(c.time)) &&
    Number.isFinite(c.open) &&
    Number.isFinite(c.high) &&
    Number.isFinite(c.low) &&
    Number.isFinite(c.close)
  );

if (convertedCandles.length === 0) {
  console.error(
    "AURUM TWELVE DATA EMPTY OR INVALID:",
    twelveData
  );

  if (redisCached && redisCached.data) {
    return await respondWithStaleCache();
  }

  return res.status(502).json({
    status: "error",
    message: "Twelve Data tidak mengirim candle valid"
  });
}

const data = {
  data: convertedCandles
};

console.log(
  "AURUM TWELVE DATA TOTAL CANDLE:",
  convertedCandles.length
);

console.log(
  "AURUM TWELVE DATA FIRST CANDLE:",
  convertedCandles[0]
);

console.log(
  "AURUM TWELVE DATA LAST CANDLE:",
  convertedCandles[convertedCandles.length - 1]
);

// URUTKAN CANDLE DARI YANG TERLAMA
let rawCandles = data.data
  .filter(c => c.time && c.open != null &&
    c.high != null && c.low != null && c.close != null)
  .sort((a, b) => Date.parse(a.time) - Date.parse(b.time));

// DIAGNOSTIK RENTANG DATA BTC
console.log(
  "AURUM BTC RAW RANGE:",
  selectedSymbol,
  rawCandles[0]?.time,
  rawCandles[rawCandles.length - 1]?.time
);

// NORMALISASI CANDLE TWELVE DATA KE FORMAT AURUM
// M45 sudah diminta langsung dari provider, tidak diagregasi ulang.
const targetBars = selected === "M45" ? 300 : 100;

const candles = rawCandles.slice(-targetBars).map(c => ({
  datetime: c.time,
  open: Number(c.open),
  high: Number(c.high),
  low: Number(c.low),
  close: Number(c.close),
  volume: Number(c.tick_volume || 0)
}));
if (!candles.length) {
  return res.status(502).json({
    status: "error",
    message: "Twelve Data tidak mengirim candle valid untuk simbol ini"
  });
}

// Use a shared Redis quote cache to avoid burning one Twelve Data credit per page poll.
let livePrice = null;
let livePriceUpdatedAt = null;
let livePriceSource = "time_series";
let livePriceStatus = "fallback";
let livePriceError = null;
if (selectedSymbol === "XAU/USD") {
  const quote = await getCachedGoldQuote();
  livePrice = quote.price;
  livePriceUpdatedAt = quote.updatedAt;
  livePriceSource = quote.source;
  livePriceStatus = quote.status;
  livePriceError = quote.error;
  // Keep provider OHLC unchanged; the live quote is displayed in a separate series.
}

const providerFetchedAt = new Date().toISOString();
const lastCandleAt = candles[candles.length - 1]?.datetime || null;
const output = {
  status: "success",
  symbol: selectedSymbol,
  interval: selected,
  source: "Twelve Data",
  providerFetchedAt,
  lastCandleAt,
  livePrice,
  livePriceUpdatedAt,
  livePriceSource,
  livePriceStatus,
  livePriceError,
  candles
};
      
// Keep fresh provider data in this instance to avoid a Redis read on every poll.
globalThis.aurumCache.set(cacheKey, {
  time: Date.now(),
  data: output
});


        // SIMPAN KE REDIS SELAMA 7 HARI
    try {
      await aurumRedis([
        "SET",
        redisKey,
        JSON.stringify({
          time: Date.now(),
          data: output
        }),
        "EX",
        "604800"
      ]);
    } catch (redisError) {
      console.error(
        "REDIS WRITE ERROR:",
        redisError.message
      );
    }

    return res.status(200).json(output);


  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
};

