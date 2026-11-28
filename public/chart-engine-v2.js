(function () {
'use strict';
const $ = id => document.getElementById(id);
const COLORS = { up: '#2563eb', down: '#ef4444', grid: '#e8edf4', text: '#64748b' };
const state = { candles: [], symbol: 'XAU/USD', tf: 'M15', busy: false, error: '', resize: null };
let canvas, ctx, host;

function setStatus(message, kind) {
  const node = $('chartFeedStatus');
  if (!node) return;
  node.textContent = message;
  node.classList.remove('is-live', 'is-closed', 'is-delayed');
  if (kind) node.classList.add(kind);
}
function symbolLabel(symbol) {
  return symbol === 'BTC/USD' ? 'BITCOIN · BTC/USD' : symbol === 'WTI' ? 'WTI OIL' : 'GOLD · XAU/USD';
}
function normalizeCandles(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  return raw.map(item => {
    const time = Math.floor(Date.parse(item.datetime || item.time || '') / 1000);
    const open = Number(item.open), high = Number(item.high), low = Number(item.low), close = Number(item.close);
    if (!Number.isFinite(time) || time <= 0 ||
        ![open, high, low, close].every(Number.isFinite) ||
        high < Math.max(open, close, low) || low > Math.min(open, close, high)) return null;
    return { time, open, high, low, close, volume: Number(item.volume) || 0 };
  }).filter(c => {
    if (!c || seen.has(c.time)) return false;
    seen.add(c.time); return true;
  }).sort((a,b) => a.time - b.time).slice(-180);
}
function mount() {
  host = $('candleChart');
  if (!host) return false;
  host.innerHTML = '';
  host.style.cssText = 'position:relative;width:100%;height:520px;min-height:520px;background:#fff;overflow:hidden;';
  canvas = document.createElement('canvas');
  canvas.setAttribute('role', 'img');
  canvas.setAttribute('aria-label', 'Grafik candlestick pasar dengan candle bullish biru dan bearish merah');
  canvas.style.cssText = 'display:block;width:100%;height:100%;';
  host.appendChild(canvas);
  ctx = canvas.getContext('2d');
  if (!ctx) {
    setStatus('● CANVAS TIDAK DIDUKUNG', 'is-delayed');
    return false;
  }
  if (window.ResizeObserver) {
    state.resize = new ResizeObserver(draw);
    state.resize.observe(host);
  } else {
    window.addEventListener('resize', draw);
  }
  draw();
  return true;
}
function draw() {
  if (!canvas || !ctx || !host) return;
  const rect = host.getBoundingClientRect();
  const width = Math.max(280, Math.floor(rect.width || host.clientWidth || 320));
  const height = 520;
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1));
  canvas.width = Math.floor(width * dpr);
  canvas.height = Math.floor(height * dpr);
  canvas.style.width = width + 'px';
  canvas.style.height = height + 'px';
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, width, height);

  if (!state.candles.length) {
    ctx.fillStyle = COLORS.text; ctx.font = '14px Arial,sans-serif';
    ctx.textAlign = 'center'; ctx.fillText(state.error || 'Menunggu data candle…', width / 2, height / 2);
    return;
  }
  const data = state.candles;
  const minRaw = Math.min(...data.map(c => c.low));
  const maxRaw = Math.max(...data.map(c => c.high));
  const spread = Math.max(maxRaw - minRaw, Math.abs(maxRaw) * 0.001, 0.01);
  const min = minRaw - spread * 0.07, max = maxRaw + spread * 0.07;
  const left = 10, right = 76, top = 18, bottom = 30;
  const plotW = Math.max(80, width - left - right);
  const plotH = height - top - bottom;
  const y = price => top + (max - price) / (max - min) * plotH;
  ctx.font = '11px Arial,sans-serif';
  ctx.textAlign = 'left';
  ctx.strokeStyle = COLORS.grid; ctx.lineWidth = 1;
  for (let i = 0; i <= 6; i++) {
    const yy = top + plotH * i / 6;
    const value = max - (max - min) * i / 6;
    ctx.beginPath(); ctx.moveTo(left, yy); ctx.lineTo(left + plotW, yy); ctx.stroke();
    ctx.fillStyle = COLORS.text;
    ctx.fillText(value.toLocaleString('en-US', { maximumFractionDigits: 2 }), left + plotW + 8, yy + 4);
  }
  const step = plotW / data.length;
  const bodyW = Math.max(2, Math.min(13, step * 0.68));
  data.forEach((c, i) => {
    const x = left + step * (i + 0.5);
    const color = c.close >= c.open ? COLORS.up : COLORS.down;
    ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineWidth = Math.max(1, Math.min(2, step * .12));
    ctx.beginPath(); ctx.moveTo(x, y(c.high)); ctx.lineTo(x, y(c.low)); ctx.stroke();
    const bodyTop = y(Math.max(c.open, c.close));
    const bodyBottom = y(Math.min(c.open, c.close));
    ctx.fillRect(x - bodyW / 2, bodyTop, bodyW, Math.max(1.5, bodyBottom - bodyTop));
  });
  const last = data[data.length - 1];
  const lastY = y(last.close);
  ctx.strokeStyle = last.close >= last.open ? COLORS.up : COLORS.down;
  ctx.setLineDash([4, 3]); ctx.beginPath(); ctx.moveTo(left, lastY); ctx.lineTo(left + plotW, lastY); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle = last.close >= last.open ? COLORS.up : COLORS.down;
  ctx.fillRect(left + plotW + 3, Math.max(top, Math.min(top + plotH - 19, lastY - 9)), right - 6, 18);
  ctx.fillStyle = '#fff'; ctx.font = 'bold 10px Arial,sans-serif';
  ctx.fillText(last.close.toLocaleString('en-US', { maximumFractionDigits: 2 }), left + plotW + 7, Math.max(top + 12, Math.min(top + plotH - 6, lastY + 3)));
  ctx.fillStyle = COLORS.text; ctx.font = '10px Arial,sans-serif';
  const firstDate = new Date(data[0].time * 1000), lastDate = new Date(last.time * 1000);
  ctx.fillText(firstDate.toLocaleDateString(), left, height - 9);
  ctx.textAlign = 'right'; ctx.fillText(lastDate.toLocaleDateString(), left + plotW, height - 9);
}
async function load(reason) {
  if (state.busy) return;
  const pair = $('pair'), tf = $('tf');
  if (!pair || !tf) return;
  const symbol = pair.value || 'XAU/USD';
  const interval = tf.value || 'M15';
  state.symbol = symbol; state.tf = interval; state.busy = true; state.error = '';
  const label = $('chartMarketLabel');
  if (label) label.textContent = symbolLabel(symbol);
  setStatus('● MENGAMBIL DATA ' + interval, 'is-delayed');
  try {
    const url = '/api?interval=' + encodeURIComponent(interval) + '&symbol=' + encodeURIComponent(symbol) + '&chartVersion=2';
    const response = await fetch(url, { method: 'GET', cache: 'no-store', headers: { Accept: 'application/json' } });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.message || ('API HTTP ' + response.status));
    if (payload.status !== 'success') throw new Error(payload.message || 'Provider tidak mengirim status sukses');
    const candles = normalizeCandles(payload.candles);
    if (!candles.length) throw new Error('API sukses tetapi tidak mengirim candle OHLC valid');
    if (symbol !== ($('pair')?.value || 'XAU/USD') || interval !== ($('tf')?.value || 'M15')) return;
    state.candles = candles;
    state.error = '';
    draw();
    const marketClosed = payload.marketStatus === 'closed';
    const age = Number(payload.candleAgeSeconds);
    const detail = candles.length + ' CANDLE · ' + (payload.source || 'DATA PROVIDER');
    setStatus((marketClosed ? '● MARKET CLOSED' : payload.livePriceStatus === 'live_quote' ? '● LIVE' : '● DATA CANDLE') + ' · ' + detail, marketClosed ? 'is-closed' : payload.livePriceStatus === 'live_quote' ? 'is-live' : 'is-delayed');
    const debug = $('aurumDebugStatus');
    if (debug) debug.textContent = 'CHART V2 OK · ' + candles.length + ' CANDLE · ' + interval;
    console.info('AURUM CHART ENGINE V2', { reason, symbol, interval, count: candles.length, source: payload.source, lastCandleAt: payload.lastCandleAt, age });
  } catch (error) {
    state.candles = [];
    state.error = 'DATA GAGAL: ' + String(error.message || error);
    draw();
    setStatus('● DATA GAGAL · ' + String(error.message || error), 'is-delayed');
    console.error('AURUM CHART ENGINE V2:', error);
  } finally {
    state.busy = false;
  }
}
function syncButtons() {
  document.querySelectorAll('.aurum-chart-timeframes [data-timeframe]').forEach(button => {
    const active = button.dataset.timeframe === ($('tf')?.value || 'M15');
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', active ? 'true' : 'false');
  });
}
function init() {
  if (!mount()) return;
  const pair = $('pair'), tf = $('tf');
  if (pair) pair.addEventListener('change', () => load('symbol-change'));
  if (tf) tf.addEventListener('change', () => { syncButtons(); load('timeframe-change'); });
  document.querySelectorAll('.aurum-chart-timeframes [data-timeframe]').forEach(button => {
    button.addEventListener('click', () => {
      if (!tf || !button.dataset.timeframe) return;
      tf.value = button.dataset.timeframe;
      syncButtons();
      load('timeframe-button');
    });
  });
  const page = $('chartPage');
  if (page && window.MutationObserver) {
    new MutationObserver(() => {
      if (page.classList.contains('active')) {
        requestAnimationFrame(() => { draw(); load('chart-page-visible'); });
      }
    }).observe(page, { attributes: true, attributeFilter: ['class'] });
  }
  window.addEventListener('hashchange', () => {
    if (location.hash === '#chartPage') setTimeout(() => { draw(); load('chart-hash-navigation'); }, 80);
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && page?.classList.contains('active')) load('tab-visible');
  });
  syncButtons();
  load('engine-v2-init');
  window.aurumLoadChartV2 = load;
  window.aurumChartV2State = state;
}
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
else init();
})();