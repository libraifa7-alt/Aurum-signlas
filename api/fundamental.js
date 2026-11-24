const SERIES = {
  us10y: {
    id: "DGS10",
    label: "US 10Y Treasury Yield",
    unit: "%",
    maxAgeDays: 7,
    source: "Federal Reserve H.15 via FRED"
  },
  broadUsd: {
    id: "DTWEXBGS",
    label: "Nominal Broad U.S. Dollar Index",
    unit: "index",
    maxAgeDays: 10,
    source: "Federal Reserve H.10 via FRED",
    note: "Indeks dolar broad-weighted; bukan ICE U.S. Dollar Index (DXY)."
  }
};

function parseLatestObservation(csv, seriesId) {
  if (typeof csv !== "string" || csv.length > 2_000_000) return null;
  const lines = csv.trim().split(/\r?\n/);
  if (lines.length < 2) return null;
  const header = lines[0].split(",");
  if (header[0] !== "observation_date" || header[1] !== seriesId) return null;

  for (let i = lines.length - 1; i >= 1; i--) {
    const columns = lines[i].split(",");
    const date = columns[0];
    const value = Number(columns[1]);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || columns[1] === "." || !Number.isFinite(value)) continue;
    const observedAt = new Date(date + "T00:00:00.000Z");
    if (!Number.isFinite(observedAt.getTime()) || observedAt.toISOString().slice(0, 10) !== date) continue;
    return { date, value };
  }
  return null;
}

module.exports = async function fundamentalHandler(req, res) {
  if (typeof res.setHeader === "function") {
    res.setHeader("Cache-Control", "no-store, max-age=0");
    res.setHeader("X-Content-Type-Options", "nosniff");
  }
  if (req.method && req.method !== "GET") {
    if (typeof res.setHeader === "function") res.setHeader("Allow", "GET");
    return res.status(405).json({ status: "error", code: "METHOD_NOT_ALLOWED", message: "Fundamental endpoint hanya menerima GET" });
  }

  const now = Date.now();
  if (!globalThis.aurumFundamentalCache) globalThis.aurumFundamentalCache = null;
  if (globalThis.aurumFundamentalCache && now - globalThis.aurumFundamentalCache.fetchedAt < 30 * 60 * 1000) {
    return res.status(200).json(globalThis.aurumFundamentalCache.payload);
  }

  const results = {};
  await Promise.all(Object.entries(SERIES).map(async ([key, config]) => {
    try {
      const url = "https://fred.stlouisfed.org/graph/fredgraph.csv?id=" + encodeURIComponent(config.id);
      const response = await fetch(url, {
        headers: { Accept: "text/csv", "User-Agent": "AurumSignals/1.0 (fundamental indicators)" },
        signal: AbortSignal.timeout(8000)
      });
      if (!response.ok) throw new Error("FRED HTTP " + response.status);
      const observation = parseLatestObservation(await response.text(), config.id);
      if (!observation) throw new Error("Observasi FRED tidak valid");
      const ageDays = Math.floor((now - Date.parse(observation.date + "T00:00:00Z")) / 86400000);
      if (ageDays < 0 || ageDays > config.maxAgeDays) throw new Error("Observasi terakhir sudah kedaluwarsa");
      results[key] = {
        status: "available",
        seriesId: config.id,
        label: config.label,
        value: observation.value,
        unit: config.unit,
        observationDate: observation.date,
        ageDays,
        source: config.source,
        ...(config.note ? { note: config.note } : {})
      };
    } catch (error) {
      results[key] = {
        status: "unavailable",
        seriesId: config.id,
        label: config.label,
        unit: config.unit,
        source: config.source,
        ...(config.note ? { note: config.note } : {}),
        message: String(error.message || "Data tidak tersedia").slice(0, 160)
      };
    }
  }));

  const payload = {
    status: "success",
    updatedAt: new Date(now).toISOString(),
    frequency: "daily",
    results
  };
  globalThis.aurumFundamentalCache = { fetchedAt: now, payload };
  return res.status(200).json(payload);
};

module.exports.parseLatestObservation = parseLatestObservation;
