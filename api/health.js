'use strict';

// Readiness diagnostics for Aurum. Never return secret values to the client.
module.exports = async function handler(req, res) {
  // Apply security/cache headers to both successful and rejected responses.
  if (typeof res.setHeader === 'function') {
    res.setHeader('Cache-Control', 'no-store, max-age=0');
    res.setHeader('X-Content-Type-Options', 'nosniff');
  }
  if (req.method !== 'GET') {
    return res.status(405).json({ status: 'error', message: 'Method not allowed' });
  }

  const env = req.env || process.env;

  const checks = {
    marketApi: 'not_probed',
    cronSecret: Boolean(env.CRON_SECRET),
    redisConfigured: Boolean(env.KV_REST_API_URL && env.KV_REST_API_TOKEN),
    pushConfigured: Boolean(
      env.VAPID_PUBLIC_KEY &&
      env.VAPID_PRIVATE_KEY &&
      env.VAPID_SUBJECT
    ),
    naifConfigured: Boolean(env.NAIF_KEY),
    twelveDataConfigured: Boolean(env.TWELVE_DATA_API_KEY)
  };

  let redis = 'not_configured';
  if (checks.redisConfigured) {
    try {
      const response = await fetch(env.KV_REST_API_URL, {
        method: 'POST',
        headers: {
          Authorization: 'Bearer ' + env.KV_REST_API_TOKEN,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(['PING']),
        signal: AbortSignal.timeout(5000)
      });
      const body = await response.json();
      redis = response.ok && body.result === 'PONG' && !body.error
        ? 'connected'
        : 'error';
    } catch (_) {
      redis = 'unreachable';
    }
  }
  checks.redis = redis;

  const ready = checks.cronSecret && checks.redisConfigured && redis === 'connected';

  // Cloudflare Pages exposes these deployment identifiers at runtime.
  // They help distinguish Preview from Production without revealing secrets.
  const deploymentBranch = env.BRANCH || env.CF_PAGES_BRANCH || null;
  const deployment = {
    platform: env.NETLIFY ? 'Netlify' : env.CF_PAGES ? 'Cloudflare Pages' : 'unknown',
    branch: deploymentBranch,
    environment: env.CONTEXT || (deploymentBranch
      ? (deploymentBranch === 'main' ? 'production' : 'preview')
      : 'unknown'),
    url: env.DEPLOY_PRIME_URL || env.CF_PAGES_URL || null
  };

  return res.status(200).json({
    status: ready ? 'ok' : 'degraded',
    message: ready
      ? 'Aurum Signals core services are configured'
      : 'Aurum Signals is available, but some services need configuration',
    deployment,
    checks,
    checkedAt: new Date().toISOString()
  });
};
