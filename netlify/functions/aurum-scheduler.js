'use strict';

// Netlify scheduled trigger for the existing server-side ICT scanner.
// Netlify schedules run only on published deploys and use UTC.
const cronHandler = require('../../api/cron.js');
const crypto = require('node:crypto');

function responseBridge() {
  let statusCode = 200;
  let body = '';
  const headers = {};
  return {
    res: {
      setHeader(name, value) { headers[name] = String(value); },
      status(code) { statusCode = code; return this; },
      json(payload) { body = JSON.stringify(payload); return this; }
    },
    getResponse() { return { statusCode, headers, body }; }
  };
}

exports.handler = async function aurumScheduler(_event, context = {}) {
  const previousSecret = process.env.CRON_SECRET;
  const previousPublicUrl = process.env.AURUM_PUBLIC_URL;

  // The scheduled invocation is authenticated by Netlify itself. Supply a
  // one-invocation credential to the shared Vercel-compatible HTTP handler.
  const invocationSecret = previousSecret || crypto.randomUUID();
  process.env.CRON_SECRET = invocationSecret;

  // The scanner must read candles from this same Netlify deployment, not the
  // old Vercel hostname used by the Vercel-only scheduler.
  if (context.site && context.site.url) {
    process.env.AURUM_PUBLIC_URL = context.site.url;
  }

  try {
    const bridge = responseBridge();
    await cronHandler({
      method: 'POST',
      headers: { authorization: 'Bearer ' + invocationSecret }
    }, bridge.res);

    const response = bridge.getResponse();
    if (response.statusCode < 200 || response.statusCode >= 300) {
      throw new Error('Aurum scanner returned HTTP ' + response.statusCode + ': ' + response.body);
    }
    console.log('AURUM scheduled scan completed:', response.body);
    return { statusCode: response.statusCode, body: response.body };
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;

    if (previousPublicUrl === undefined) delete process.env.AURUM_PUBLIC_URL;
    else process.env.AURUM_PUBLIC_URL = previousPublicUrl;
  }
};

// Every five minutes. Netlify evaluates this schedule in UTC.
exports.config = { schedule: '*/5 * * * *' };
