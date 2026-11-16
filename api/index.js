
module.exports = async function handler(req, res) {
  if (!globalThis.aurumCache) {
    globalThis.aurumCache = new Map();
  }

  const allowedIntervals = {
    M1: "1min",
    M5: "5min",
    M15: "15min",
    M30: "30min",
    H1: "1h",
    H4: "4h"
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

  if (cached && Date.now() - cached.time < 60000) {
    return res.status(200).json(cached.data);
  }

  try {
    // JALUR KHUSUS WTI DARI YAHOO FINANCE
    if (selectedSymbol === "WTI") {
      const yahooIntervals = {
        M1: "1m",
        M5: "5m",
        M15: "15m",
        M30: "30m",
        H1: "60m",
        H4: "60m"
      };

      const yahooInterval = yahooIntervals[selected] || "15m";

 const url = new URL(
  "https://query1.finance.yahoo.com/v8/finance/chart/CL%3DF"
);

      url.searchParams.set("range", "5d");
      url.searchParams.set("interval", yahooInterval);

      const response = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      });

      const data = await response.json();
      const result = data.chart?.result?.[0];

      if (!response.ok || !result) {
        return res.status(502).json({
          status: "error",
          message: data.chart?.error?.description || "Gagal mengambil data WTI"
        });
      }

      const timestamps = result.timestamp || [];
      const quote = result.indicators?.quote?.[0];

      if (!quote) {
        return res.status(502).json({
          status: "error",
          message: "Data candle WTI tidak tersedia"
        });
      }

      const candles = timestamps.map((timestamp, i) => {
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

        const datetime = new Date(
          (timestamp + 7 * 3600) * 1000
        ).toISOString().slice(0, 19).replace("T", " ");

        return {
          datetime,
          open: String(open),
          high: String(high),
          low: String(low),
          close: String(close)
        };
      }).filter(Boolean).reverse().slice(0, 100);

      const output = {
        status: "success",
        symbol: "WTI",
        interval: yahooInterval,
        candles
      };

      globalThis.aurumCache.set(cacheKey, {
        time: Date.now(),
        data: output
      });

      return res.status(200).json(output);
    }

    // BTC DAN XAU TETAP MENGGUNAKAN TWELVE DATA
    const apiKey = process.env.TWELVE_DATA_API_KEY;

    if (!apiKey) {
      return res.status(500).json({
        status: "error",
        message: "API Key belum ditemukan"
      });
    }

    const allowedSymbols = {
  "XAU": "XAU/USD",
  "XAU/USD": "XAU/USD",
  "BTC/USD": "BTC/USD"
};

    const symbol = allowedSymbols[selectedSymbol];

    if (!symbol) {
      return res.status(400).json({
        status: "error",
        message: "Instrumen tidak didukung"
      });
    }

    const url = new URL(
      "https://api.twelvedata.com/time_series"
    );

    url.searchParams.set("symbol", symbol);
    url.searchParams.set("interval", interval);
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("apikey", apiKey);

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.status === "error") {
      return res.status(502).json({
        status: "error",
        message: data.message || "Gagal mengambil data market"
      });
    }

    const output = {
      status: "success",
      symbol,
      interval,
      candles: data.values || []
    };

    globalThis.aurumCache.set(cacheKey, {
      time: Date.now(),
      data: output
    });

    return res.status(200).json(output);

  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: error.message
    });
  }
};
        
