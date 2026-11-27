

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
  const cacheSource = (selectedSymbol === "WTI" || selectedSymbol === "BTC/USD") ? "yahoo" : selectedSymbol === "XAU/USD" ? "xaus-chart" : "twelvedata";
  const cacheKey = selectedSymbol + ":" + interval + ":" + cacheSource + ((selectedSymbol === "XAU/USD" || selectedSymbol === "WTI" || selectedSymbol === "BTC/USD") ? ":v3" : ":v2");
  const cached = globalThis.aurumCache.get(cacheKey);

  // Recalculate BTC/WTI candle freshness from the candle timestamps on every
  // response. A recent fetch/cache write must never make old candles look live.
  function withYahooCandleFreshness(payload, cacheLabel) {
    if (!payload || (selectedSymbol !== "WTI" && selectedSymbol !== "BTC/USD")) {
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
  const cacheTTL = (selectedSymbol === "WTI" || selectedSymbol === "BTC/USD")
    ? 60000
    : selectedSymbol === "XAU/USD"
      ? ({
          "1min": 60000,
          "5min": 60000,
          "15min": 60000,
          "30min": 120000,
          "45min": 120000,
          "1h": 180000,
          "4h": 300000,
          "1day": 900000
        }[interval] || 60000)
      : ({
          "1min": 60000,
          "5min": 120000,
          "15min": 180000,
          "30min": 300000,
          "45min": 300000,
          "1h": 600000,
          "4h": 900000,
          "1day": 1800000
        }[interval] || 180000);

  if (selectedSymbol !== "XAU/USD" && !debugRaw && !debugQuote && cached && Date.now() - cached.time < cacheTTL) {
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

      if (selectedSymbol !== "XAU/USD" && !debugRaw && !debugQuote && Date.now() - redisCached.time < cacheTTL) {
        return res.status(200).json(withYahooCandleFreshness(redisCached.data, "redis"));
      }
    }


    // GOLD DATA: XAUS spot quote + XAUS OHLCV chart (tanpa API key Twelve Data).
    // Candle hanya berasal dari endpoint OHLCV; harga spot tidak disisipkan ke candle historis.
    if (selectedSymbol === "XAU/USD" && !debugRaw && !debugQuote) {
      const quoteKey = "aurum:quote:XAUUSD:xaus:v1";
      const naifQuoteKey = "aurum:quote:XAUUSD:naif:v1";
      let savedQuote = null;
      try {
        const rawQuote = await aurumRedis(["GET", quoteKey]);
        if (rawQuote) savedQuote = JSON.parse(rawQuote);
      } catch (error) {
        console.warn("XAUS QUOTE CACHE READ:", error.message);
      }

      const savedAge = savedQuote?.receivedAt
        ? Date.now() - Date.parse(savedQuote.receivedAt)
        : Infinity;

      let quote = savedQuote && Number.isFinite(Number(savedQuote.price)) &&
        savedAge >= 0 && savedAge < 60000
        ? { ...savedQuote, cache: "redis_quote" }
        : null;

      if (!quote) {
        let xausFailure = null;
        try {
          const xausResponse = await fetch("https://xaus.com/api/v1/spot?compact=1", {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(8000)
          });
          const xausData = await xausResponse.json();
          const price = Number(xausData.spot_usd_oz);
          const asOf = xausData.price_as_of || xausData.updated_at || xausData.data_state?.as_of || null;
          const asOfAge = asOf ? Date.now() - Date.parse(asOf) : Infinity;
          const isFresh = xausResponse.ok && Number.isFinite(price) && price > 0 &&
            asOfAge >= -60000 && asOfAge <= 180000 &&
            xausData.stale !== true && xausData.data_state?.status !== "stale";

          if (isFresh) {
            quote = {
              price,
              receivedAt: asOf || new Date().toISOString(),
              fetchedAt: new Date().toISOString(),
              source: "XAUS spot API",
              status: "live_quote",
              cache: "provider",
              attribution: null,
              error: null
            };
            try {
              await aurumRedis(["SET", quoteKey, JSON.stringify(quote), "EX", "86400"]);
            } catch (error) {
              console.warn("XAUS QUOTE CACHE WRITE:", error.message);
            }
          } else {
            xausFailure = xausData.error || (xausData.stale ? "XAUS mengembalikan harga stale" : "Timestamp harga XAUS tidak cukup baru");
          }
        } catch (error) {
          xausFailure = String(error.message || "XAUS tidak dapat dihubungi").slice(0, 180);
        }

        // NAIF Free fallback: rates refresh every 60 seconds.
        // Keep this quote separate from OHLC candles; never synthesize candles from spot prices.
        if (!quote && env.NAIF_KEY) {
          try {
            let naifQuote = null;
            const cachedNaifRaw = await aurumRedis(["GET", naifQuoteKey]);
            if (cachedNaifRaw) {
              const parsedNaif = JSON.parse(cachedNaifRaw);
              const age = parsedNaif?.fetchedAt ? Date.now() - Date.parse(parsedNaif.fetchedAt) : Infinity;
              if (age >= 0 && age < 60000 && Number.isFinite(Number(parsedNaif.price))) {
                naifQuote = { ...parsedNaif, cache: "redis_naif_quote" };
              }
            }

            if (!naifQuote) {
              const naifUrl = new URL("https://api.naif.ae/api/v1/rates");
              naifUrl.searchParams.set("symbols", "XAUUSD");
              const naifResponse = await fetch(naifUrl, {
                headers: {
                  "Accept": "application/json",
                  "Authorization": "Bearer " + env.NAIF_KEY,
                  "Origin": "https://aurum-signals-ai.vercel.app",
                  "Referer": "https://aurum-signals-ai.vercel.app/"
                },
                signal: AbortSignal.timeout(8000)
              });
              const naifBody = await naifResponse.json();
              if (!naifResponse.ok) {
                throw new Error("Naif API HTTP " + naifResponse.status);
              }
              const item = Array.isArray(naifBody.items)
                ? naifBody.items.find(entry => String(entry.code || "").toUpperCase() === "XAUUSD")
                : null;
              const buy = Number(item?.buy);
              const sell = Number(item?.sell);
              const price = Number.isFinite(buy) && buy > 0 && Number.isFinite(sell) && sell > 0
                ? (buy + sell) / 2
                : NaN;
              const updatedAt = item?.updated_at || naifBody.generated_at || null;
              const updatedAge = updatedAt ? Date.now() - Date.parse(updatedAt) : Infinity;
              if (!item || !Number.isFinite(price) || price <= 0 ||
                  !Number.isFinite(updatedAge) || updatedAge < -60000 || updatedAge > 180000 ||
                  item.stale === true) {
                throw new Error("Naif tidak mengirim harga XAUUSD yang valid dan cukup baru");
              }

              naifQuote = {
                price,
                buy,
                sell,
                receivedAt: updatedAt,
                fetchedAt: new Date().toISOString(),
                source: "Naif API (buy/sell midpoint)",
                status: "delayed_quote",
                cache: "provider",
                attribution: "Prices from naif.ae",
                refreshSeconds: Number(naifBody.refresh_seconds) || 60,
                error: null
              };
              await aurumRedis(["SET", naifQuoteKey, JSON.stringify(naifQuote), "EX", "86400"]);
            }
            quote = naifQuote;
          } catch (error) {
            console.warn("NAIF QUOTE FALLBACK:", error.message);
            quote = savedQuote && Number.isFinite(Number(savedQuote.price))
              ? { ...savedQuote, status: "stale_quote", cache: "redis_stale_quote", error: xausFailure || error.message }
              : { price: null, receivedAt: null, source: "XAUS + Naif spot API", status: "quote_unavailable", cache: "provider_error", attribution: null, error: String(error.message || xausFailure || "Harga spot tidak tersedia").slice(0, 180) };
          }
        } else if (!quote) {
          quote = savedQuote && Number.isFinite(Number(savedQuote.price))
            ? { ...savedQuote, status: "stale_quote", cache: "redis_stale_quote", error: xausFailure }
            : { price: null, receivedAt: null, source: "XAUS spot API", status: "quote_unavailable", cache: "provider_error", attribution: null, error: xausFailure || "NAIF_KEY belum dikonfigurasi" };
        }
      }

      const chartConfig = {
        M1: { interval: "1m", range: "1d" },
        M5: { interval: "5m", range: "5d" },
        M15: { interval: "15m", range: "5d" },
        M30: { interval: "30m", range: "1mo" },
        M45: { interval: "15m", range: "5d", aggregateSeconds: 2700, sourceSeconds: 900, groupSize: 3 },
        H1: { interval: "60m", range: "3mo" },
        H4: { interval: "60m", range: "3mo", aggregateSeconds: 14400, sourceSeconds: 3600, groupSize: 4 },
        D1: { interval: "1d", range: "2y" }
      };
      const config = chartConfig[selected] || chartConfig.M15;
      const cachedGold = redisCached?.data || cached?.data || null;
      // Gunakan waktu fetch provider, bukan waktu cache ditulis ulang.
      // Fallback candle lama tidak boleh memperpanjang umur data.
      const cachedGoldFetchedAt = cachedGold?.providerFetchedAt
        ? Date.parse(cachedGold.providerFetchedAt)
        : Number(redisCached?.time || cached?.time || NaN);
      const cachedGoldAge = Number.isFinite(cachedGoldFetchedAt)
        ? Date.now() - cachedGoldFetchedAt
        : Infinity;
      const cachedGoldHasFutureCandles = Array.isArray(cachedGold?.candles) &&
        cachedGold.candles.some(candle => {
          const candleTime = Date.parse(candle?.datetime || "");
          return Number.isFinite(candleTime) && candleTime > Date.now() + 60000;
        }) ||
        (Number.isFinite(Date.parse(cachedGold?.lastCandleAt || "")) &&
          Date.parse(cachedGold.lastCandleAt) > Date.now() + 60000);

      let candleData = cachedGold &&
        Array.isArray(cachedGold.candles) &&
        !cachedGoldHasFutureCandles &&
        cachedGoldAge >= 0 && cachedGoldAge < cacheTTL
        ? cachedGold
        : null;

      let chartError = null;
      const chartErrorKey = "aurum:provider-error:xaus-chart:" + selected + ":v1";
      let chartCoolingDown = false;
      if (!candleData) {
        try {
          const rawChartError = await aurumRedis(["GET", chartErrorKey]);
          if (rawChartError) {
            const savedChartError = JSON.parse(rawChartError);
            const errorAge = savedChartError?.receivedAt
              ? Date.now() - Date.parse(savedChartError.receivedAt)
              : Infinity;
            if (errorAge >= 0 && errorAge < 30000) {
              chartError = savedChartError.message || "XAUS Chart sedang jeda setelah kegagalan";
              chartCoolingDown = true;
            }
          }
        } catch (error) {
          console.warn("XAUS CHART COOLDOWN READ:", error.message);
        }
      }
      if (!candleData && !chartCoolingDown) {
        try {
          const chartUrl = new URL("https://xaus.com/api/v1/chart");
          chartUrl.searchParams.set("symbol", "xau");
          chartUrl.searchParams.set("range", config.range);
          chartUrl.searchParams.set("interval", config.interval);

          const chartResponse = await fetch(chartUrl, {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(12000)
          });
          const chartPayload = await chartResponse.json();

          if (!chartResponse.ok) {
            throw new Error(chartPayload?.error || "XAUS Chart HTTP " + chartResponse.status);
          }

          const rawPoints = Array.isArray(chartPayload.points)
            ? chartPayload.points
            : Array.isArray(chartPayload.data)
              ? chartPayload.data
              : Array.isArray(chartPayload.candles)
                ? chartPayload.candles
                : [];

          // Reject provider candles timestamped materially in the future.
          // A future timestamp must never be clamped to age zero and labeled fresh.
          const serverNowMs = Date.now();
          const futureToleranceMs = 60000;

          let candles = rawPoints.map(point => {
            const rawTimestamp = point.t ?? point.timestamp ?? point.time;
            let timestamp = Number(rawTimestamp);
            if (!Number.isFinite(timestamp) && typeof rawTimestamp === "string") {
              timestamp = Date.parse(rawTimestamp) / 1000;
            }
            if (timestamp > 1000000000000) timestamp = timestamp / 1000;

            const open = Number(point.o ?? point.open);
            const high = Number(point.h ?? point.high);
            const low = Number(point.l ?? point.low);
            const close = Number(point.c ?? point.close);
            const volume = Number(point.v ?? point.volume ?? 0);

            if (!Number.isFinite(timestamp) || timestamp <= 0 ||
                timestamp * 1000 > serverNowMs + futureToleranceMs ||
                !Number.isFinite(open) || !Number.isFinite(high) ||
                !Number.isFinite(low) || !Number.isFinite(close) ||
                open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
                high < Math.max(open, close, low) ||
                low > Math.min(open, close, high)) return null;

            return {
              timestamp: Math.floor(timestamp),
              datetime: new Date(timestamp * 1000).toISOString(),
              open, high, low, close,
              volume: Number.isFinite(volume) ? volume : 0
            };
          }).filter(Boolean).sort((a, b) => a.timestamp - b.timestamp);

          if (config.aggregateSeconds) {
            const buckets = new Map();
            for (const candle of candles) {
              const bucket = Math.floor(candle.timestamp / config.aggregateSeconds) * config.aggregateSeconds;
              if (!buckets.has(bucket)) buckets.set(bucket, []);
              buckets.get(bucket).push(candle);
            }

            candles = Array.from(buckets.entries())
              .filter(([, group]) => group.length === config.groupSize)
              .map(([bucket, group]) => {
                group.sort((a, b) => a.timestamp - b.timestamp);
                return {
                  timestamp: bucket,
                  datetime: new Date(bucket * 1000).toISOString(),
                  open: group[0].open,
                  high: Math.max(...group.map(item => item.high)),
                  low: Math.min(...group.map(item => item.low)),
                  close: group[group.length - 1].close,
                  volume: group.reduce((sum, item) => sum + item.volume, 0)
                };
              });
          }

          const targetBars = selected === "M45" ? 300 : 500;
          candles = candles.slice(-targetBars);

          if (!candles.length) {
            throw new Error("XAUS Chart tidak mengirim candle OHLC yang valid");
          }

          const lastCandleAt = candles[candles.length - 1].datetime;
          const rawCandleAgeSeconds = Math.floor((Date.now() - Date.parse(lastCandleAt)) / 1000);
          if (!Number.isFinite(rawCandleAgeSeconds) || rawCandleAgeSeconds < -60) {
            throw new Error("Timestamp candle XAUS berada di masa depan; data ditolak agar harga tidak dianggap live");
          }
          const candleAgeSeconds = Math.max(0, rawCandleAgeSeconds);
          const freshnessLimit = ({
            M1: 300, M5: 900, M15: 2700, M30: 5400,
            M45: 8100, H1: 10800, H4: 43200, D1: 259200
          }[selected] || 2700);

          candleData = {
            status: "success",
            symbol: selectedSymbol,
            interval: selected,
            source: "XAUS Chart API (OHLCV)",
            candleSource: "XAUS Chart API",
            providerFetchedAt: new Date().toISOString(),
            lastCandleAt,
            candleAgeSeconds,
            candleStatus: candleAgeSeconds <= freshnessLimit ? "fresh_candles" : "stale_candles",
            candles
          };

          globalThis.aurumCache.set(cacheKey, { time: Date.now(), data: candleData });
          try {
            await aurumRedis(["DEL", chartErrorKey]);
          } catch (error) {
            console.warn("XAUS CHART COOLDOWN CLEAR:", error.message);
          }
          try {
            await aurumRedis([
              "SET",
              redisKey,
              JSON.stringify({ time: Date.now(), data: candleData }),
              "EX",
              "604800"
            ]);
          } catch (error) {
            console.warn("XAUS CHART CACHE WRITE:", error.message);
          }
        } catch (error) {
          chartError = String(error.message || "XAUS Chart tidak dapat dihubungi").slice(0, 180);
          try {
            await aurumRedis([
              "SET",
              chartErrorKey,
              JSON.stringify({ message: chartError, receivedAt: new Date().toISOString() }),
              "EX",
              "30"
            ]);
          } catch (cacheError) {
            console.warn("XAUS CHART COOLDOWN WRITE:", cacheError.message);
          }
          if (cachedGold && !cachedGoldHasFutureCandles && Array.isArray(cachedGold.candles) && cachedGold.candles.length) {
            candleData = {
              ...cachedGold,
              candleStatus: "stale_candles",
              candleError: chartError,
              cache: "stale_candle_fallback"
            };
            // Jangan menulis ulang timestamp cache saat fallback.
            // Waktu provider asli tetap dipakai agar candle stale tidak dianggap segar.
          }
        }
      }

      // Fallback candle Gold ke Twelve Data jika XAUS Chart gagal/tidak mengirim OHLC valid.
      // Harga spot XAUS tetap terpisah; candle tidak pernah dibuat dari harga spot.
      const twelveFallbackKey = String(env.TWELVE_DATA_API_KEY || "").trim().replace(/^['"]|['"]$/g, "");
      if (!candleData && twelveFallbackKey) {
        try {
          const fallbackUrl = new URL("https://api.twelvedata.com/time_series");
          fallbackUrl.searchParams.set("symbol", "XAU/USD");
          fallbackUrl.searchParams.set("interval", interval);
          fallbackUrl.searchParams.set("outputsize", selected === "M45" ? "300" : "500");
          fallbackUrl.searchParams.set("timezone", "UTC");
          fallbackUrl.searchParams.set("order", "ASC");
          fallbackUrl.searchParams.set("apikey", twelveFallbackKey);

          const fallbackResponse = await fetch(fallbackUrl, {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(12000)
          });
          const fallbackPayload = await fallbackResponse.json();
          if (!fallbackResponse.ok || fallbackPayload.status === "error" || !Array.isArray(fallbackPayload.values)) {
            throw new Error(fallbackPayload.message || fallbackPayload.code || "Twelve Data tidak mengirim candle OHLC");
          }

          const fallbackCandles = fallbackPayload.values.map(point => {
            const rawDate = String(point.datetime || "").trim();
            const normalizedDate = rawDate.includes("T") ? rawDate : rawDate.replace(" ", "T");
            const dateText = /[zZ]|[+-]\d{2}:\d{2}$/.test(normalizedDate) ? normalizedDate : normalizedDate + "Z";
            const timestampMs = Date.parse(dateText);
            const open = Number(point.open);
            const high = Number(point.high);
            const low = Number(point.low);
            const close = Number(point.close);
            const volume = Number(point.volume || 0);
            if (!Number.isFinite(timestampMs) || timestampMs <= 0 || timestampMs > Date.now() + 60000 ||
                !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close) ||
                open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
                high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
            return {
              timestamp: Math.floor(timestampMs / 1000),
              datetime: new Date(timestampMs).toISOString(),
              open, high, low, close,
              volume: Number.isFinite(volume) ? volume : 0
            };
          }).filter(Boolean).sort((left, right) => left.timestamp - right.timestamp).slice(-(selected === "M45" ? 300 : 500));

          if (!fallbackCandles.length) throw new Error("Twelve Data tidak mengirim candle XAU/USD yang valid");
          const lastCandleAt = fallbackCandles[fallbackCandles.length - 1].datetime;
          const rawAge = Math.floor((Date.now() - Date.parse(lastCandleAt)) / 1000);
          if (!Number.isFinite(rawAge) || rawAge < -60) throw new Error("Timestamp candle Twelve Data tidak valid");

          const freshnessLimit = ({
            M1: 300, M5: 900, M15: 2700, M30: 5400,
            M45: 8100, H1: 10800, H4: 43200, D1: 259200
          }[selected] || 2700);
          candleData = {
            status: "success",
            symbol: selectedSymbol,
            interval: selected,
            source: "Twelve Data OHLCV (fallback)",
            candleSource: "Twelve Data fallback",
            providerFetchedAt: new Date().toISOString(),
            lastCandleAt,
            candleAgeSeconds: Math.max(0, rawAge),
            candleStatus: rawAge <= freshnessLimit ? "fresh_candles" : "stale_candles",
            candles: fallbackCandles
          };

          globalThis.aurumCache.set(cacheKey, { time: Date.now(), data: candleData });
          try {
            await aurumRedis(["DEL", chartErrorKey]);
            await aurumRedis(["SET", redisKey, JSON.stringify({ time: Date.now(), data: candleData }), "EX", "604800"]);
          } catch (cacheError) {
            console.warn("TWELVE DATA GOLD FALLBACK CACHE:", cacheError.message);
          }
        } catch (fallbackError) {
          chartError = [chartError, "Twelve Data fallback: " + String(fallbackError.message || "gagal").slice(0, 140)].filter(Boolean).join(" | ");
          console.warn("XAUS CHART + TWELVE DATA FALLBACK:", fallbackError.message);
        }
      }

      if (!candleData && chartCoolingDown && cachedGold && !cachedGoldHasFutureCandles && Array.isArray(cachedGold.candles) && cachedGold.candles.length) {
        candleData = {
          ...cachedGold,
          candleStatus: "stale_candles",
          candleError: chartError,
          cache: "stale_candle_fallback"
        };
      }

      if (!candleData || !Array.isArray(candleData.candles) || !candleData.candles.length) {
        return res.status(503).json({
          status: "provider_error",
          symbol: selectedSymbol,
          interval: selected,
          source: "XAUS spot + XAUS Chart API",
          livePrice: quote?.price ?? null,
          livePriceUpdatedAt: quote?.receivedAt ?? null,
          livePriceSource: quote?.source || "XAUS spot API",
          livePriceStatus: quote?.status || "quote_unavailable",
          livePriceAttribution: quote?.attribution || null,
          livePriceBuy: quote?.buy ?? null,
          livePriceSell: quote?.sell ?? null,
          livePriceError: quote?.error || null,
          candleStatus: "unavailable",
          candleError: chartError || "Candle OHLC belum tersedia dari provider",
          candles: [],
          message: "Tidak ada candle valid yang dapat ditampilkan. AURUM tidak membuat candle palsu."
        });
      }

      // Derive freshness from the actual newest candle in the payload.
      // Cached metadata can lag behind the candle array and must not misreport its age.
      const newestCandle = candleData.candles.reduce((latest, candle) =>
        Date.parse(candle?.datetime || "") > Date.parse(latest?.datetime || "") ? candle : latest,
        candleData.candles[0]
      );
      const lastCandleAt = newestCandle.datetime;
      const rawCandleAgeSeconds = Math.floor((Date.now() - Date.parse(lastCandleAt)) / 1000);
      const candleAgeSeconds = Number.isFinite(rawCandleAgeSeconds)
        ? Math.max(0, rawCandleAgeSeconds)
        : null;
      const freshnessLimit = ({
        M1: 300, M5: 900, M15: 2700, M30: 5400,
        M45: 8100, H1: 10800, H4: 43200, D1: 259200
      }[selected] || 2700);
      // Re-evaluate freshness on EVERY response. A cached candle's old
      // "fresh_candles" label must expire as its actual timestamp ages.
      const candleIsFresh = Number.isFinite(rawCandleAgeSeconds) &&
        rawCandleAgeSeconds >= -60 &&
        rawCandleAgeSeconds <= freshnessLimit;
      const output = {
        ...candleData,
        status: "success",
        symbol: selectedSymbol,
        interval: selected,
        source: candleData.source || "XAUS Chart API (OHLCV)",
        providerFetchedAt: candleData.providerFetchedAt || null,
        lastCandleAt,
        candleAgeSeconds,
        candleStatus: candleIsFresh ? "fresh_candles" : "stale_candles",
        livePrice: quote?.price ?? null,
        livePriceUpdatedAt: quote?.receivedAt ?? null,
        livePriceSource: quote?.source || "XAUS spot API",
        livePriceStatus: quote?.status || "quote_unavailable",
        livePriceAttribution: quote?.attribution || null,
        livePriceBuy: quote?.buy ?? null,
        livePriceSell: quote?.sell ?? null,
        livePriceError: quote?.error || null,
        cache: candleData.cache || (candleData === cachedGold ? "cached_ohlcv" : "xaus_chart_ohlcv"),
        candleError: candleData.candleError || chartError || null
      };

      globalThis.aurumCache.set(cacheKey, { time: Date.now(), data: output });
      return res.status(200).json(output);
    }

    // Cooldown Twelve Data hanya berlaku untuk simbol yang masih memakai provider tersebut.
    const providerErrorKey = "aurum:provider-error:" + cacheKey;
    const globalProviderErrorKey = "aurum:provider-error:twelvedata:global:v1";
    if (selectedSymbol === "XAU/USD" && !debugRaw) {
      try {
        const globalErrorRaw = await aurumRedis(["GET", globalProviderErrorKey]);
        const intervalErrorRaw = await aurumRedis(["GET", providerErrorKey]);
        const errorRaw = globalErrorRaw || intervalErrorRaw;
        if (errorRaw) {
          const providerError = JSON.parse(errorRaw);
          const errorAge = providerError?.receivedAt
            ? Date.now() - Date.parse(providerError.receivedAt)
            : Infinity;
          if (errorAge >= 0 && errorAge < 300000) {
            if (redisCached && redisCached.data) {
              return await respondWithStaleCache();
            }
            return res.status(503).json({
              status: "provider_cooldown",
              symbol: selectedSymbol,
              interval: selected,
              message: "Twelve Data sedang dalam masa jeda setelah kegagalan provider. Coba kembali setelah 5 menit.",
              providerError: providerError.message || "Provider sementara tidak tersedia"
            });
          }
        }
      } catch (error) {
        console.warn("AURUM PROVIDER COOLDOWN READ:", error.message);
      }
    }

    
      
      

   

    // Jalur Yahoo Finance terpisah untuk BTC dan WTI agar keduanya tidak bergantung pada kuota Twelve Data.
    if (selectedSymbol === "WTI" || selectedSymbol === "BTC/USD") {
      const yahooSymbol = selectedSymbol === "WTI" ? "CL=F" : "BTC-USD";
      const assetLabel = selectedSymbol === "WTI" ? "WTI" : "BTC/USD";
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
      const output = withYahooCandleFreshness({
        status: "success",
        symbol: selectedSymbol,
        interval: selected,
        source: `Yahoo Finance (${yahooSymbol})`,
        providerFetchedAt: new Date().toISOString(),
        lastCandleAt: candles[candles.length - 1].datetime,
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

