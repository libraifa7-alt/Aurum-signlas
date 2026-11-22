

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

  const cacheKey = selectedSymbol + ":" + interval;
  const cached = globalThis.aurumCache.get(cacheKey);

  // AURUM SMART API CACHE OPTIMIZATION
  const cacheTTL = selectedSymbol === "WTI"
    ? 60000
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

  if (cached && Date.now() - cached.time < cacheTTL) {
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

      if (Date.now() - redisCached.time < cacheTTL) {
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

// JALUR DATA XAU/USD DAN BTC/USD DARI MARKETAPI



const symbol =
  selectedSymbol === "BTC/USD"
    ? "BITCOIN"
    : selectedSymbol.replaceAll("/", "");

const apiKey = process.env.MARKETAPI_API_KEY;

if (!apiKey) {
  if (redisCached && redisCached.data) {
    return res.status(200).json({
      ...redisCached.data,
      cache: "stale"
    });
  }

  return res.status(500).json({
    status: "error",
    message: "MARKETAPI_API_KEY belum diatur"
  });
}
      

// MARKETAPI TIDAK MENDUKUNG M45 LANGSUNG
// M45 DIBENTUK DARI 3 CANDLE M15
const marketTimeframe = selected === "M45" ? "M15" : selected;

const timeframeMinutes = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  M45: 45,
  H1: 60,
  H4: 240,
  D1: 1440
};

const minutes = timeframeMinutes[selected] || 15;

const limit = selected === "M45" ? 400 : 120;




// AURUM SMART HISTORICAL RANGE
// Hanya mengambil data yang dibutuhkan chart


const targetBars = selected === "M45"
  ? 300
  : 100;

const sourceMinutes =
  timeframeMinutes[marketTimeframe] || minutes;

const lookbackMs =
  sourceMinutes *
  60 *
  1000 *
  targetBars *
  1.2;

const fromDate = new Date(
  Date.now() - lookbackMs
);

const toDate = new Date();

const marketUrl = new URL(
  "https://api.marketapi.app/v1/bars"
);
      
      

marketUrl.searchParams.set("symbol", symbol);
marketUrl.searchParams.set("timeframe", marketTimeframe);
marketUrl.searchParams.set("from", fromDate.toISOString());
marketUrl.searchParams.set("to", toDate.toISOString());
marketUrl.searchParams.set("limit", String(limit));

// AURUM MARKETAPI PAGINATION
let allBars = [];
let nextCursor = null;
let response = null;
let data = null;
let pageCount = 0;
const maxPages = 20;

do {
  const pageUrl = new URL(marketUrl.toString());

  if (nextCursor) {
    pageUrl.searchParams.set("cursor", nextCursor);
  }

  const pageResponse = await fetch(pageUrl, {
    headers: {
      "Authorization": "Bearer " + apiKey
    }
  });

  const pageData = await pageResponse.json();


  if (
    !pageResponse.ok ||
    !Array.isArray(pageData.data)
  ) {
    console.error(
      "AURUM MARKETAPI FIRST PAGE ERROR:",
      {
        status: pageResponse.status,
        statusText: pageResponse.statusText,
        pageData: pageData
      }
    );

    if (allBars.length === 0) {
      response = pageResponse;
      data = pageData;
    } else {
      console.error(
        "MARKETAPI PAGINATION ERROR:",
        pageData
      );
    }

    break;
  }
  

  response = pageResponse;

  allBars.push(...pageData.data);

  nextCursor = pageData.next_cursor || null;
  console.log(
  "AURUM HAS NEXT CURSOR:",
  Boolean(nextCursor)
);

  pageCount++;

} while (
  nextCursor &&
  pageCount < maxPages
);


// GABUNGKAN SEMUA HALAMAN CANDLE
if (allBars.length > 0) {
  data = {
    data: allBars
  };

  // AURUM RAW CANDLE DIAGNOSTIC
  console.log(
    "AURUM FIRST RAW CANDLE:",
    allBars[0]
  );

  console.log(
    "AURUM LAST RAW CANDLE:",
    allBars[allBars.length - 1]
  );
}
      

// AURUM TIMEFRAME DEBUG
console.log(
  "AURUM TIMEFRAME CHECK:",
  selectedSymbol,
  selected,
  "MARKET:",
  marketTimeframe,
  "LIMIT:",
  limit
);

// AURUM MARKETAPI TOTAL CANDLE
console.log(
  "AURUM MARKETAPI TOTAL RAW CANDLE:",
  allBars.length
);

// AURUM MARKETAPI TOTAL PAGE
console.log(
  "AURUM MARKETAPI TOTAL PAGE:",
  pageCount
);
      


if (
  !response ||
  !response.ok ||
  !data ||
  !Array.isArray(data.data)
) {
  if (redisCached && redisCached.data) {
    return res.status(200).json({
      ...redisCached.data,
      cache: "stale"
    });
  }

  return res.status(502).json({
    status: "error",
    message:
      data?.detail ||
      data?.title ||
      data?.message ||
      "Gagal mengambil data MarketAPI"
  });
}
      

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

// KONVERSI FORMAT MARKETAPI KE FORMAT AURUM
let candles;

if (selected === "M45") {
  const groups = new Map();

  rawCandles.forEach(c => {
    const timestamp = Date.parse(c.time);
    const bucket = Math.floor(timestamp / 2700000) * 2700000;

    if (!groups.has(bucket)) {
  groups.set(bucket, {
    timestamp,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.tick_volume || 0)
  });
} else {
  const group = groups.get(bucket);

  group.high = Math.max(group.high, Number(c.high));
  group.low = Math.min(group.low, Number(c.low));
  group.close = Number(c.close);
  group.volume += Number(c.tick_volume || 0);
}
});

candles = Array.from(groups.entries())
  .sort((a, b) => a[0] - b[0])
  .slice(-100)
  .map(([time, c]) => ({
    datetime: new Date(time).toISOString(),
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
    volume: c.volume
  }));

} else {
  candles = rawCandles.slice(-100).map(c => ({
    datetime: c.time,
    open: Number(c.open),
    high: Number(c.high),
    low: Number(c.low),
    close: Number(c.close),
    volume: Number(c.tick_volume || 0)
  }));
}
if (!candles.length) {
  return res.status(502).json({
    status: "error",
    message: "MarketAPI tidak mengirim candle untuk simbol ini"
  });
}

const output = {
  status: "success",
  symbol: selectedSymbol,
  interval: selected,
  candles
};
      

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

