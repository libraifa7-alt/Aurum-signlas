

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

  const interval = allowedIntervals[selected] || "15min";
  const debugRaw = req.query.debug === "raw" && selectedSymbol === "XAU/USD";
  const debugQuote = req.query.debug === "quote" && selectedSymbol === "XAU/USD";

  // Versioned provider cache prevents old MarketAPI candles being reused.
  const cacheSource = selectedSymbol === "WTI" ? "yahoo" : "twelvedata";
  const cacheKey = selectedSymbol + ":" + interval + ":" + cacheSource + ":v2";
  const cached = globalThis.aurumCache.get(cacheKey);

  // AURUM SMART API CACHE OPTIMIZATION
  const cacheTTL = selectedSymbol === "WTI"
    ? 60000
    : selectedSymbol === "XAU/USD" && interval === "1min"
      ? 15000
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

  if (!debugRaw && !debugQuote && cached && Date.now() - cached.time < cacheTTL) {
    return res.status(200).json(cached.data);
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

      if (!debugRaw && !debugQuote && Date.now() - redisCached.time < cacheTTL) {
        return res.status(200).json(redisCached.data);
      }
    }

    
      
      

   

    // JALUR KHUSUS WTI DARI YAHOO FINANCE
    if (selectedSymbol === "WTI") {
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
        "https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF"
      );

      url.searchParams.set(
        "range",
        selected === "D1" ? "1y" :
        selected === "M45" ? "1mo" : "5d"
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
            ...redisCached.data,
            cache: "stale"
          });
        }

        return res.status(502).json({
          status: "error",
          message:
            data.chart?.error?.description ||
            "Gagal mengambil data WTI"
        });
      }

      const timestamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0];

      if (!quote) {
        if (redisCached && redisCached.data) {
          return res.status(200).json({
            ...redisCached.data,
            cache: "stale"
          });
        }

        return res.status(502).json({
          status: "error",
          message: "Data candle WTI tidak tersedia"
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

      // HASIL DATA WTI
      const output = {
        status: "success",
        symbol: selectedSymbol,
        interval: selected,
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

// Safe diagnostic for the Gold quote endpoint; never returns the API key.
if (debugQuote) {
  try {
    const diagnosticUrl = new URL("https://api.twelvedata.com/price");
    diagnosticUrl.searchParams.set("symbol", selectedSymbol);
    diagnosticUrl.searchParams.set("apikey", twelveApiKey);
    const diagnosticResponse = await fetch(diagnosticUrl, { cache: "no-store" });
    const diagnosticData = await diagnosticResponse.json();
    const diagnosticPrice = Number(diagnosticData.price);
    return res.status(200).json({
      status: diagnosticResponse.ok && Number.isFinite(diagnosticPrice) && diagnosticPrice > 0 ? "success" : "provider_error",
      diagnostic: "xauusd_price_endpoint",
      symbol: selectedSymbol,
      httpStatus: diagnosticResponse.status,
      price: Number.isFinite(diagnosticPrice) && diagnosticPrice > 0 ? diagnosticPrice : null,
      receivedAt: new Date().toISOString(),
      providerCode: diagnosticData.code || null,
      providerMessage: diagnosticData.message || null
    });
  } catch (diagnosticError) {
    return res.status(502).json({
      status: "request_error",
      diagnostic: "xauusd_price_endpoint",
      message: String(diagnosticError.message || "Gagal menghubungi Twelve Data").slice(0, 180)
    });
  }
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

  if (redisCached && redisCached.data) {
    return res.status(200).json({
      ...redisCached.data,
      cache: "stale"
    });
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
    return res.status(200).json({
      ...redisCached.data,
      cache: "stale"
    });
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

// For Gold M1, request the latest quote separately from completed candles.
// REST quote is still subject to the user's Twelve Data plan and provider latency.
let livePrice = null;
let livePriceUpdatedAt = null;
let livePriceSource = "time_series";
let livePriceStatus = "fallback";
let livePriceError = null;
if (selectedSymbol === "XAU/USD" && interval === "1min") {
  try {
    const priceUrl = new URL("https://api.twelvedata.com/price");
    priceUrl.searchParams.set("symbol", selectedSymbol);
    priceUrl.searchParams.set("apikey", twelveApiKey);
    const priceResponse = await fetch(priceUrl);
    const priceData = await priceResponse.json();
    const quote = Number(priceData.price);
    if (priceResponse.ok && Number.isFinite(quote) && quote > 0) {
      livePrice = quote;
      livePriceUpdatedAt = new Date().toISOString();
      livePriceSource = "Twelve Data /price";
      livePriceStatus = "live_quote";
      const last = candles[candles.length - 1];
      last.close = quote;
      last.high = Math.max(Number(last.high), quote);
      last.low = Math.min(Number(last.low), quote);
    } else {
      livePriceError = String(priceData.message || priceData.code || "Twelve Data /price tidak memberikan kuotasi").slice(0, 180);
      console.warn("AURUM XAU LIVE PRICE UNAVAILABLE:", livePriceError);
    }
  } catch (priceError) {
    livePriceError = String(priceError.message || "Gagal mengambil kuotasi").slice(0, 180);
    console.warn("AURUM XAU LIVE PRICE ERROR:", livePriceError);
  }
}

const output = {
  status: "success",
  symbol: selectedSymbol,
  interval: selected,
  source: "Twelve Data",
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

