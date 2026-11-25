'use strict';

const marketHandler = require('../../api/index.js');
const healthHandler = require('../../api/health.js');
const signalsHandler = require('../../api/signals.js');
const fundamentalHandler = require('../../api/fundamental.js');
const pushSubscribeHandler = require('../../api/push-subscribe.js');

const handlers = {
  '': marketHandler,
  health: healthHandler,
  signals: signalsHandler,
  fundamental: fundamentalHandler,
  'push-subscribe': pushSubscribeHandler
};

function responseBridge() {
  let statusCode = 200;
  const headers = {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, max-age=0',
    'X-Content-Type-Options': 'nosniff'
  };
  let body = null;

  return {
    res: {
      setHeader(name, value) { headers[name] = String(value); },
      status(code) { statusCode = code; return this; },
      json(payload) { body = JSON.stringify(payload); return this; }
    },
    getResponse() { return { statusCode, headers, body: body || '' }; }
  };
}

function routeFromEventPath(pathname) {
  const marker = '/.netlify/functions/aurum-api';
  const markerIndex = pathname.indexOf(marker);
  if (markerIndex >= 0) {
    return pathname.slice(markerIndex + marker.length).split('/').filter(Boolean).join('/');
  }
  // Netlify may preserve the original request path in event.path during rewrites.
  return (pathname === '/api' ? '' : pathname.startsWith('/api/') ? pathname.slice(5) : pathname).split('/').filter(Boolean).join('/');
}

exports.handler = async function handler(event) {
  const route = routeFromEventPath(event.path || '/.netlify/functions/aurum-api');
  if (route === 'cron') {
    return {
      statusCode: 503,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({
        status: 'not_configured',
        code: 'CRON_RUNTIME_NOT_CONFIGURED',
        message: 'Pemindai terjadwal belum diaktifkan pada Netlify.'
      })
    };
  }

  const apiHandler = handlers[route];
  if (!apiHandler) {
    return {
      statusCode: 404,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      body: JSON.stringify({ status: 'error', code: 'NOT_FOUND', message: 'API route tidak ditemukan' })
    };
  }

  let body;
  if (event.body && event.httpMethod !== 'GET' && event.httpMethod !== 'HEAD') {
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body, 'base64').toString('utf8')
        : event.body;
      body = raw ? JSON.parse(raw) : undefined;
    } catch (_) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
        body: JSON.stringify({ status: 'error', code: 'INVALID_JSON', message: 'Body JSON tidak valid' })
      };
    }
  }

  const bridge = responseBridge();
  const req = {
    method: event.httpMethod || 'GET',
    env: process.env,
    headers: Object.fromEntries(Object.entries(event.headers || {}).map(([key, value]) => [key.toLowerCase(), value])),
    query: event.queryStringParameters || {},
    body
  };

  try {
    await apiHandler(req, bridge.res);
    const response = bridge.getResponse();
    if (route === 'health' && response.body) {
      const payload = JSON.parse(response.body);
      payload.app = 'Aurum Signals AI';
      payload.api = 'mounted';
      payload.host = 'Netlify Functions';
      response.body = JSON.stringify(payload);
    }
    return response;
  } catch (error) {
    console.error('AURUM Netlify API error:', route, error);
    return {
      statusCode: 500,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store, max-age=0',
        'X-Content-Type-Options': 'nosniff'
      },
      body: JSON.stringify({ status: 'error', message: 'Terjadi kesalahan server' })
    };
  }
};
