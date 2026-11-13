
export default async function handler(req, res) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    return res.status(500).json({
      status: "error",
      message: "API Key belum ditemukan"
    });
  }

  try {
    const url = new URL(
      "https://api.twelvedata.com/time_series"
    );

    url.searchParams.set("symbol", "XAU/USD");
    url.searchParams.set("interval", "15min");
    url.searchParams.set("outputsize", "100");
    url.searchParams.set("apikey", apiKey);

    const response = await fetch(url);
    const data = await response.json();

    if (!response.ok || data.status === "error") {
      return res.status(502).json({
        status: "error",
        message: data.message || "Gagal mengambil data XAUUSD"
      });
    }

    return res.status(200).json({
      status: "success",
      symbol: "XAU/USD",
      interval: "15min",
      candles: data.values || []
    });
  } catch (error) {
    return res.status(500).json({
      status: "error",
      message: "Terjadi kesalahan koneksi data"
    });
  }
}
