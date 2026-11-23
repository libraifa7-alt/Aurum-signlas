

module.exports = async function handler(req, res) {
  if (!globalThis.aurumCache) {
    globalThis.aurumCache = new Map();
  }

  // AURUM REDIS CONNECTION
  async function aurumRedis(command) {
    const redisUrl = process.env.KV_REST_API_URL;
    const redisToken = process.env.KV_REST_API_TOKEN;

    if (!redisUrl || !redisToken) {
      return null;
    }

    const response = await fetch(redisUrl, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + redisToken,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(command)
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
  const cacheKey = selectedSymbol + ":" + interval + ":" + cacheSource + ((selectedSymbol === "XAU/USD" || selectedSymbol === "WTI" || selectedSymbol === "BTC/USD") ? ":v4" : ":v2");
  const cached = globalThis.aurumCache.get(cacheKey);

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

  // Recalculate candle age whenever Yahoo cache is served; cache age is not candle age.
  function withYahooCandleFreshness(payload) {
    if (selectedSymbol !== "WTI" && selectedSymbol !== "BTC/USD") return payload;
    const lastCandleAt = payload?.lastCandleAt || payload?.candles?.[payload.candles.length - 1]?.datetime || null;
    const timestamp = lastCandleAt ? Date.parse(lastCandleAt) : NaN;
    const ageMs = Number.isFinite(timestamp) ? Date.now() - timestamp : NaN;
    // Timestamp masa depan/invalid tidak boleh dianggap candle baru.
    const candleAgeSeconds = Number.isFinite(ageMs) && ageMs >= 0
      ? Math.floor(ageMs / 1000)
      : null;
    const freshnessLimitSeconds = ({
      M1: 180, M5: 600, M15: 1800, M30: 3600,
      M45: 5400, H1: 7200, H4: 28800, D1: 172800
    }[selected] || 1800);
    return {
      ...payload,
      lastCandleAt,
      candleAgeSeconds,
      candleStatus: candleAgeSeconds !== null && candleAgeSeconds <= freshnessLimitSeconds
        ? "fresh_candles"
        : "stale_candles"
    };
  }

  if (selectedSymbol !== "XAU/USD" && !debugRaw && !debugQuote && cached && Date.now() - cached.time < cacheTTL) {
    return res.status(200).json(withYahooCandleFreshness(cached.data));
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
        return res.status(200).json(withYahooCandleFreshness(redisCached.data));
      }
    }


    // GOLD DATA: XAUS spot quote + XAUS OHLCV chart (tanpa API key Twelve Data).
    // Candle hanya berasal dari endpoint OHLCV; harga spot tidak disisipkan ke candle historis.
    if (selectedSymbol === "XAU/USD" && !debugRaw && !debugQuote) {
      const quoteKey = "aurum:quote:XAUUSD:xaus:v1";
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
              error: null
            };
            try {
              await aurumRedis(["SET", quoteKey, JSON.stringify(quote), "EX", "86400"]);
            } catch (error) {
              console.warn("XAUS QUOTE CACHE WRITE:", error.message);
            }
          } else {
            const reason = xausData.error || (xausData.stale ? "XAUS mengembalikan harga stale" : "Timestamp harga XAUS tidak cukup baru");
            quote = savedQuote && Number.isFinite(Number(savedQuote.price))
              ? { ...savedQuote, status: "stale_quote", cache: "redis_stale_quote", error: reason }
              : { price: null, receivedAt: null, source: "XAUS spot API", status: "quote_unavailable", cache: "provider_error", error: reason };
          }
        } catch (error) {
          quote = savedQuote && Number.isFinite(Number(savedQuote.price))
            ? { ...savedQuote, status: "stale_quote", cache: "redis_stale_quote", error: String(error.message || "XAUS tidak dapat dihubungi").slice(0, 180) }
            : { price: null, receivedAt: null, source: "XAUS spot API", status: "quote_unavailable", cache: "provider_error", error: String(error.message || "XAUS tidak dapat dihubungi").slice(0, 180) };
        }
      }

      // Reuse a fresh Twelve Data fallback for at most the normal API cache window.
      // This prevents repeated quota-consuming calls while keeping timestamp checks strict.
      const cachedTwelveGold = redisCached?.data?.candleSource === "Twelve Data"
        ? redisCached.data
        : null;
      if (cachedTwelveGold && Date.now() - Number(redisCached.time || 0) < cacheTTL) {
        const fallbackLastAt = cachedTwelveGold.lastCandleAt || cachedTwelveGold.candles?.[cachedTwelveGold.candles.length - 1]?.datetime || null;
        const fallbackAgeMs = fallbackLastAt ? Date.now() - Date.parse(fallbackLastAt) : NaN;
        const fallbackAgeSeconds = Number.isFinite(fallbackAgeMs) && fallbackAgeMs >= 0
          ? Math.floor(fallbackAgeMs / 1000)
          : null;
        const fallbackLimit = ({ M1: 180, M5: 600, M15: 1800, M30: 3600, M45: 5400, H1: 7200, H4: 28800, D1: 172800 }[selected] || 1800);
        if (fallbackAgeSeconds !== null && fallbackAgeSeconds <= fallbackLimit) {
          return res.status(200).json({
            ...cachedTwelveGold,
            lastCandleAt: fallbackLastAt,
            candleAgeSeconds: fallbackAgeSeconds,
            candleStatus: "fresh_candles",
            livePrice: quote?.price ?? null,
            livePriceUpdatedAt: quote?.receivedAt ?? null,
            livePriceSource: quote?.source || "XAUS spot API",
            livePriceStatus: quote?.status || "quote_unavailable",
            livePriceError: quote?.error || null,
            cache: "twelvedata_fallback_cache"
          });
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
      const cachedGoldCandidate = redisCached?.data || cached?.data || null;
      // Cache key versions are isolated, but verify provenance before reusing Gold candles.
      // Twelve Data fallback candles must never be mislabeled as XAUS Chart data.
      const cachedGold = cachedGoldCandidate && (
        cachedGoldCandidate.candleSource === "XAUS Chart API" ||
        cachedGoldCandidate.source === "XAUS Chart API (OHLCV)"
      ) ? cachedGoldCandidate : null;
      // Gunakan waktu fetch provider, bukan waktu cache ditulis ulang.
      // Fallback candle lama tidak boleh memperpanjang umur data.
      const cachedGoldFetchedAt = cachedGold?.providerFetchedAt
        ? Date.parse(cachedGold.providerFetchedAt)
        : Number(redisCached?.time || cached?.time || NaN);
      const cachedGoldAge = Number.isFinite(cachedGoldFetchedAt)
        ? Date.now() - cachedGoldFetchedAt
        : Infinity;

      let candleData = cachedGold &&
        Array.isArray(cachedGold.candles) &&
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

          let candles = rawPoints.map(point => {
            let timestamp = Number(point.t ?? point.timestamp ?? point.time);
            if (!Number.isFinite(timestamp) && typeof point.t === "string") {
              timestamp = Date.parse(point.t) / 1000;
            }
            if (timestamp > 1000000000000) timestamp = timestamp / 1000;

            const open = Number(point.o ?? point.open);
            const high = Number(point.h ?? point.high);
            const low = Number(point.l ?? point.low);
            const close = Number(point.c ?? point.close);
            const volume = Number(point.v ?? point.volume ?? 0);

            if (!Number.isFinite(timestamp) || timestamp <= 0 ||
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
          const rawCandleAgeSeconds = (Date.now() - Date.parse(lastCandleAt)) / 1000;
          const candleAgeSeconds = Number.isFinite(rawCandleAgeSeconds) && rawCandleAgeSeconds >= 0
            ? Math.floor(rawCandleAgeSeconds)
            : null;
          // Keep backend candle freshness thresholds aligned with the chart UI.
          const freshnessLimit = ({
            M1: 180, M5: 600, M15: 1800, M30: 3600,
            M45: 5400, H1: 7200, H4: 28800, D1: 172800
          }[selected] || 1800);

          candleData = {
            status: "success",
            symbol: selectedSymbol,
            interval: selected,
            source: "XAUS Chart API (OHLCV)",
            candleSource: "XAUS Chart API",
            providerFetchedAt: new Date().toISOString(),
            lastCandleAt,
            candleAgeSeconds,
            candleStatus: candleAgeSeconds !== null && candleAgeSeconds <= freshnessLimit ? "fresh_candles" : "stale_candles",
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
          if (cachedGold && Array.isArray(cachedGold.candles) && cachedGold.candles.length) {
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

      if (!candleData && chartCoolingDown && cachedGold && Array.isArray(cachedGold.candles) && cachedGold.candles.length) {
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
          livePriceError: quote?.error || null,
          candleStatus: "unavailable",
          candleError: chartError || "Candle OHLC belum tersedia dari provider",
          candles: [],
          message: "Tidak ada candle valid yang dapat ditampilkan. AURUM tidak membuat candle palsu."
        });
      }

      const lastCandleAt = candleData.lastCandleAt || candleData.candles[candleData.candles.length - 1].datetime;
      const rawCandleAgeSeconds = (Date.now() - Date.parse(lastCandleAt)) / 1000;
      const candleAgeSeconds = Number.isFinite(rawCandleAgeSeconds) && rawCandleAgeSeconds >= 0
        ? Math.floor(rawCandleAgeSeconds)
        : null;
      const candleFreshnessLimitSeconds = ({
        M1: 180, M5: 600, M15: 1800, M30: 3600,
        M45: 5400, H1: 7200, H4: 28800, D1: 172800
      }[selected] || 1800);
      const candleStatus = candleAgeSeconds !== null &&
        candleAgeSeconds <= candleFreshnessLimitSeconds
        ? "fresh_candles"
        : "stale_candles";
      const output = {
        ...candleData,
        status: "success",
        symbol: selectedSymbol,
        interval: selected,
        source: candleData.source || "XAUS Chart API (OHLCV)",
        candleSource: candleData.candleSource || "XAUS Chart API",
        providerFetchedAt: candleData.providerFetchedAt || null,
        lastCandleAt,
        candleAgeSeconds,
        candleStatus,
        livePrice: quote?.price ?? null,
        livePriceUpdatedAt: quote?.receivedAt ?? null,
        livePriceSource: quote?.source || "XAUS spot API",
        livePriceStatus: quote?.status || "quote_unavailable",
        livePriceError: quote?.error || null,
        cache: candleData.cache || (candleData === cachedGold ? "cached_ohlcv" : "xaus_chart_ohlcv"),
        candleError: candleData.candleError || chartError || null
      };

      if (candleStatus === "fresh_candles") {
        globalThis.aurumCache.set(cacheKey, { time: Date.now(), data: output });
        return res.status(200).json(output);
      }

      // XAUS Chart is a Yahoo Finance proxy. Try an independent MT5 tick/OHLC feed
      // before Twelve Data when the primary Gold candle is stale.
      chartError = chartError || ("XAUS Chart candle stale: " + (candleAgeSeconds === null ? "timestamp invalid/future" : candleAgeSeconds + " seconds old"));
      console.warn("AURUM GOLD PRIMARY CANDLE SOURCE STALE; TRYING BIQUOTE MT5:", {
        interval: selected,
        lastCandleAt,
        candleAgeSeconds
      });

      try {
        const biquoteIntervals = {
          M1: "1m", M5: "5m", M15: "15m", M30: "30m",
          M45: "15m", H1: "1h", H4: "4h", D1: "1d"
        };
        const biquoteInterval = biquoteIntervals[selected];
        const biquoteLimits = {
          M1: 300, M5: 288, M15: 192, M30: 192,
          M45: 300, H1: 168, H4: 180, D1: 500
        };
        const biquoteUrl = new URL("https://biquote.io/api/XAUUSD/ohlc");
        biquoteUrl.searchParams.set("interval", biquoteInterval);
        biquoteUrl.searchParams.set("limit", String(biquoteLimits[selected] || 100));

        const [barsResponse, tickResponse] = await Promise.all([
          fetch(biquoteUrl, {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(10000)
          }),
          fetch("https://biquote.io/api/XAUUSD?allowStale=false", {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(8000)
          })
        ]);
        const [biquotePayload, biquoteTick] = await Promise.all([
          barsResponse.json(),
          tickResponse.json()
        ]);
        if (!barsResponse.ok) {
          throw new Error(biquotePayload?.message || "BiQuote OHLC HTTP " + barsResponse.status);
        }

        let biquoteBars = (Array.isArray(biquotePayload.bars) ? biquotePayload.bars : [])
          .filter(bar => bar && bar.isOpen !== true)
          .map(bar => {
            const timestamp = Date.parse(bar.openTime);
            const open = Number(bar.open);
            const high = Number(bar.high);
            const low = Number(bar.low);
            const close = Number(bar.close);
            const volume = Number(bar.tickVolume ?? bar.volume ?? 0);
            if (!Number.isFinite(timestamp) || timestamp <= 0 ||
                ![open, high, low, close].every(Number.isFinite) ||
                open <= 0 || high <= 0 || low <= 0 || close <= 0 ||
                high < Math.max(open, close, low) ||
                low > Math.min(open, close, high)) return null;
            return {
              timestamp: Math.floor(timestamp / 1000),
              datetime: new Date(timestamp).toISOString(),
              open, high, low, close,
              volume: Number.isFinite(volume) ? volume : 0
            };
          })
          .filter(Boolean)
          .sort((a, b) => a.timestamp - b.timestamp);

        if (selected === "M45") {
          const buckets = new Map();
          for (const bar of biquoteBars) {
            const bucket = Math.floor(bar.timestamp / 2700) * 2700;
            if (!buckets.has(bucket)) buckets.set(bucket, []);
            buckets.get(bucket).push(bar);
          }
          biquoteBars = Array.from(buckets.entries())
            .filter(([bucket, group]) =>
              group.length === 3 &&
              group.some(bar => bar.timestamp === bucket) &&
              group.some(bar => bar.timestamp === bucket + 900) &&
              group.some(bar => bar.timestamp === bucket + 1800)
            )
            .map(([bucket, group]) => {
              group.sort((a, b) => a.timestamp - b.timestamp);
              return {
                timestamp: bucket,
                datetime: new Date(bucket * 1000).toISOString(),
                open: group[0].open,
                high: Math.max(...group.map(bar => bar.high)),
                low: Math.min(...group.map(bar => bar.low)),
                close: group[2].close,
                volume: group.reduce((sum, bar) => sum + bar.volume, 0)
              };
            });
        }

        const biquoteLast = biquoteBars[biquoteBars.length - 1];
        const biquoteAgeMs = biquoteLast ? Date.now() - Date.parse(biquoteLast.datetime) : NaN;
        const biquoteAgeSeconds = Number.isFinite(biquoteAgeMs) && biquoteAgeMs >= 0
          ? Math.floor(biquoteAgeMs / 1000)
          : null;
        const biquoteFreshnessLimit = ({
          M1: 180, M5: 600, M15: 1800, M30: 3600,
          M45: 5400, H1: 7200, H4: 28800, D1: 172800
        }[selected] || 1800);

        if (!biquoteLast || biquoteAgeSeconds === null || biquoteAgeSeconds > biquoteFreshnessLimit) {
          throw new Error("BiQuote candle stale/invalid: " + (biquoteAgeSeconds === null ? "timestamp invalid" : biquoteAgeSeconds + " seconds old"));
        }

        const tickMid = Number(biquoteTick?.mid);
        const tickUpdatedAt = biquoteTick?.timestamp || biquoteTick?.lastQuoteAt || null;
        const tickAgeMs = tickUpdatedAt ? Date.now() - Date.parse(tickUpdatedAt) : NaN;
        const tickAgeSeconds = Number.isFinite(tickAgeMs) && tickAgeMs >= 0
          ? Math.floor(tickAgeMs / 1000)
          : null;
        const tickIsFresh = Number.isFinite(tickMid) && tickMid > 0 &&
          tickAgeSeconds !== null && tickAgeSeconds <= 120 &&
          biquoteTick?.stale !== true && biquoteTick?.marketState !== "closed";

        const biquoteOutput = {
          status: "success",
          symbol: selectedSymbol,
          interval: selected,
          source: "BiQuote MT5 (XAUUSD CFD)",
          candleSource: "BiQuote MT5",
          providerFetchedAt: new Date().toISOString(),
          lastCandleAt: biquoteLast.datetime,
          candleAgeSeconds: biquoteAgeSeconds,
          candleStatus: "fresh_candles",
          livePrice: Number.isFinite(tickMid) && tickMid > 0 ? tickMid : null,
          livePriceUpdatedAt: tickUpdatedAt,
          livePriceSource: biquoteTick?.source || "BiQuote MT5",
          livePriceStatus: tickIsFresh ? "live_quote" : "stale_quote",
          livePriceError: tickIsFresh ? null : (biquoteTick?.message || "Kuotasi BiQuote belum memenuhi batas kesegaran"),
          marketStatus: biquoteTick?.marketState || null,
          candles: biquoteBars.slice(-500)
        };

        console.log("AURUM GOLD USING BIQUOTE MT5 FALLBACK:", {
          interval: selected,
          lastCandleAt: biquoteOutput.lastCandleAt,
          candleAgeSeconds: biquoteOutput.candleAgeSeconds,
          livePriceStatus: biquoteOutput.livePriceStatus,
          bars: biquoteOutput.candles.length
        });
        globalThis.aurumCache.set(cacheKey, { time: Date.now(), data: biquoteOutput });
        try {
          await aurumRedis([
            "SET", redisKey,
            JSON.stringify({ time: Date.now(), data: biquoteOutput }),
            "EX", "604800"
          ]);
        } catch (error) {
          console.warn("BIQUOTE GOLD CACHE WRITE:", error.message);
        }
        return res.status(200).json(biquoteOutput);
      } catch (biquoteError) {
        console.warn("AURUM BIQUOTE GOLD FALLBACK FAILED; TRYING TWELVE DATA:", String(biquoteError.message || biquoteError).slice(0, 180));
      }
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
        }
      });

      const data = await response.json();
      const result = data.chart?.result?.[0];

      if (!response.ok || !result) {
        if (redisCached && redisCached.data) {
          return res.status(200).json({
            ...withYahooCandleFreshness(redisCached.data),
            cache: "stale"
          });
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
          return res.status(200).json({
            ...withYahooCandleFreshness(redisCached.data),
            cache: "stale"
          });
        }

        return res.status(502).json({
          status: "error",
          message: `Data candle ${assetLabel} tidak tersedia`
        });
      }

      let candles = timestamps.map((timestamp, i) => {
        const open = quote.open?.[i];
        const high = quote.high?.[i];
        const low = quote.low?.[i];
        const close = quote.close?.[i];

        if (
          open == null ||
          high == null ||
          low == null ||
          close == null
        ) {
          return null;
        }

        return {
          datetime: new Date(timestamp * 1000).toISOString(),
          open,
          high,
          low,
          close,
          volume: quote.volume?.[i] || 0
        };
      
      }).filter(Boolean);

      // AGREGASI KHUSUS TIMEFRAME M45
      if (selected === "M45") {
        const aggregated = [];

        for (let i = 0; i + 2 < candles.length; i += 3) {
          const group = candles.slice(i, i + 3);

          aggregated.push({
            datetime: group[0].datetime,
            open: group[0].open,
            high: Math.max(...group.map(c => c.high)),
            low: Math.min(...group.map(c => c.low)),
            close: group[2].close,
            volume: group.reduce(
              (sum, c) => sum + c.volume,
              0
            )
          });
        }

        candles = aggregated;
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

      // Status kesegaran candle Yahoo dihitung dari waktu candle terakhir,
      // bukan hanya waktu respons provider. Ini mencegah data lama terlihat live.
      const lastCandleAt = candles[candles.length - 1].datetime;
      const lastCandleMs = Date.parse(lastCandleAt);
      const candleAgeMs = Number.isFinite(lastCandleMs)
        ? Date.now() - lastCandleMs
        : NaN;
      // Tolak timestamp masa depan agar tidak pernah lolos sebagai fresh.
      const candleAgeSeconds = Number.isFinite(candleAgeMs) && candleAgeMs >= 0
        ? Math.floor(candleAgeMs / 1000)
        : null;
      const freshnessLimitSeconds = ({
        M1: 180,
        M5: 600,
        M15: 1800,
        M30: 3600,
        M45: 5400,
        H1: 7200,
        H4: 28800,
        D1: 172800
      }[selected] || 1800);
      const candleStatus = candleAgeSeconds !== null &&
        candleAgeSeconds <= freshnessLimitSeconds
        ? "fresh_candles"
        : "stale_candles";

      // HASIL DATA WTI + penanda waktu agar kesegaran data dapat diperiksa.
      const output = {
        status: "success",
        symbol: selectedSymbol,
        interval: selected,
        source: `Yahoo Finance (${yahooSymbol})`,
        providerFetchedAt: new Date().toISOString(),
        lastCandleAt,
        candleAgeSeconds,
        candleStatus,
        candles
      };

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

const twelveApiKey = process.env.TWELVE_DATA_API_KEY;

if (!twelveApiKey) {
  if (redisCached && redisCached.data) {
    return await respondWithStaleCache();
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
  const cachedPayload = redisCached.data;
  const cachedLastCandleAt = cachedPayload?.lastCandleAt || cachedPayload?.candles?.[cachedPayload.candles.length - 1]?.datetime || null;
  const cachedTimestamp = cachedLastCandleAt ? Date.parse(cachedLastCandleAt) : NaN;
  const cachedAgeMs = Number.isFinite(cachedTimestamp) ? Date.now() - cachedTimestamp : NaN;
  const cachedAgeSeconds = Number.isFinite(cachedAgeMs) && cachedAgeMs >= 0 ? Math.floor(cachedAgeMs / 1000) : null;
  const fallback = {
    ...cachedPayload,
    lastCandleAt: cachedLastCandleAt,
    candleAgeSeconds: cachedAgeSeconds,
    candleStatus: "stale_candles",
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
    Number.isFinite(c.close) &&
    c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0 &&
    c.high >= Math.max(c.open, c.close, c.low) &&
    c.low <= Math.min(c.open, c.close, c.high)
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
const candleAgeMs = lastCandleAt ? Date.now() - Date.parse(lastCandleAt) : NaN;
const candleAgeSeconds = Number.isFinite(candleAgeMs) && candleAgeMs >= 0
  ? Math.floor(candleAgeMs / 1000)
  : null;
const candleFreshnessLimitSeconds = ({
  M1: 180, M5: 600, M15: 1800, M30: 3600,
  M45: 5400, H1: 7200, H4: 28800, D1: 172800
}[selected] || 1800);
const candleStatus = candleAgeSeconds !== null && candleAgeSeconds <= candleFreshnessLimitSeconds
  ? "fresh_candles"
  : "stale_candles";
const output = {
  status: "success",
  symbol: selectedSymbol,
  interval: selected,
  source: "Twelve Data",
  candleSource: "Twelve Data",
  providerFetchedAt,
  lastCandleAt,
  candleAgeSeconds,
  candleStatus,
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

