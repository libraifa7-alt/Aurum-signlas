module.exports = async function handler(req, res) {
    if (!globalThis.aurumCache) {
    globalThis.aurumCache = new Map();
    }
  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      status: "error",
      message: "API Key belum ditemukan"
    });
  }

  const allowedIntervals = {
  M1: "1min",
  M5: "5min",
  M15: "15min",
  M30: "30min",
  H1: "1h",
  H4: "4h"
  };
const allowedSymbols = {
  "XAU/USD": "XAU/USD",
  "BTC/USD": "BTC/USD",
  "WTI": "WTI/USD"
};

const selectedSymbol = String(req.query.symbol || "XAU/USD").toUpperCase();
const symbol = allowedSymbols[selectedSymbol];

if (!symbol) {
  return res.status(400).json({
    status: "error",
    message: "Instrumen tidak didukung"
  });
}

const selected = String(req.query.interval || "M15").toUpperCase();
const interval = allowedIntervals[selected] || "15min";

const cacheKey = symbol + ":" + interval;
const cached = globalThis.aurumCache.get(cacheKey);

  if (cached && Date.now() - cached.time < 60000) {
    return res.status(200).json(cached.data);
  }
  
try {
 const url = new URL("https://api.twelvedata.com/time_series");

url.searchParams.set("symbol", symbol);
  url.searchParams.set("interval", interval);
  url.searchParams.set("outputsize", "100");
  url.searchParams.set("apikey", apiKey);

  const response = await fetch(url);
  const data = await response.json();
      if (response.ok && data.status !== "error" && data.values) {
      globalThis.aurumCache.set(cacheKey, {
        time: Date.now(),
        data: {
          status: "success",
          symbol: symbol,
          interval,
          candles: data.values
        }
      });
      }

  if (!response.ok || data.status === "error") {
    return res.status(502).json({
      status: "error",
      message: data.message || "Gagal mengambil data XAUUSD"
    });
  }

return res.status(200).json({
  status: "success",
  symbol: symbol,
  interval,
  candles: data.values || []
});
} catch (error) {
  return res.status(500).json({
    status: "error",
    message: error.message
  });
}
};
