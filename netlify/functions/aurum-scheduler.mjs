import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const cronHandler = require('../../api/cron.js');

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

export default async function aurumScheduler(_request, context = {}) {
  const previousSecret = process.env.CRON_SECRET;
  const previousPublicUrl = process.env.AURUM_PUBLIC_URL;

  // Netlify authenticates scheduled invocations. Supply a one-invocation
  // credential to the existing Vercel-compatible scanner handler.
  const invocationSecret = previousSecret || randomUUID();
  process.env.CRON_SECRET = invocationSecret;

  const publicUrl = context.site?.url || process.env.URL || 'https://aurum-signlas.netlify.app';
  process.env.AURUM_PUBLIC_URL = publicUrl;

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
    return new Response(response.body, {
      status: response.statusCode,
      headers: { 'content-type': 'application/json', ...response.headers }
    });
  } finally {
    if (previousSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = previousSecret;

    if (previousPublicUrl === undefined) delete process.env.AURUM_PUBLIC_URL;
    else process.env.AURUM_PUBLIC_URL = previousPublicUrl;
  }
}

export const config = { schedule: '*/5 * * * *' };
