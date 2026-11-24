const test = require('node:test');
const assert = require('node:assert/strict');
const cronHandler = require('../api/cron.js');

test('Telegram notification reports missing credentials without making a request', async () => {
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const oldChat = process.env.TELEGRAM_CHAT_ID;
  const oldFetch = global.fetch;
  delete process.env.TELEGRAM_BOT_TOKEN;
  delete process.env.TELEGRAM_CHAT_ID;
  let called = false;
  global.fetch = async () => { called = true; throw new Error('must not fetch'); };
  try {
    assert.equal(await cronHandler.sendTelegramSignal('XAU/USD', { direction: 'BUY' }, 'https://aurum-signals-ai.vercel.app'), 'not_configured');
    assert.equal(called, false);
  } finally {
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    if (oldChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = oldChat;
    global.fetch = oldFetch;
  }
});

test('Telegram notification sends escaped signal details with a bounded request', async () => {
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const oldChat = process.env.TELEGRAM_CHAT_ID;
  const oldFetch = global.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.TELEGRAM_CHAT_ID = '-100123456';
  let requestUrl = '';
  let requestOptions = null;
  global.fetch = async (url, options) => {
    requestUrl = String(url);
    requestOptions = options;
    return { ok: true, status: 200, async json() { return { ok: true, result: { message_id: 1 } }; } };
  };
  try {
    const result = await cronHandler.sendTelegramSignal('XAU/USD', {
      direction: 'BUY',
      generatedAt: '2026-11-25T10:00:00.000Z',
      tradePlan: { entryLow: 4000, entryHigh: 4010, sl: 3980, tp1: 4030, tp2: 4050, tp3: 4080 }
    }, 'https://aurum-signals-ai.vercel.app');
    assert.equal(result, 'sent');
    assert.match(requestUrl, /api\.telegram\.org\/bottest-token\/sendMessage/);
    assert.ok(requestOptions.signal instanceof AbortSignal);
    const body = JSON.parse(requestOptions.body);
    assert.equal(body.chat_id, '-100123456');
    assert.equal(body.parse_mode, 'HTML');
    assert.match(body.text, /AURUM SIGNAL/);
    assert.match(body.text, /4000/);
  } finally {
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    if (oldChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = oldChat;
    global.fetch = oldFetch;
  }
});

test('Telegram provider failures do not leak the bot token in the error', async () => {
  const oldToken = process.env.TELEGRAM_BOT_TOKEN;
  const oldChat = process.env.TELEGRAM_CHAT_ID;
  const oldFetch = global.fetch;
  process.env.TELEGRAM_BOT_TOKEN = 'secret-token-value';
  process.env.TELEGRAM_CHAT_ID = '123';
  global.fetch = async () => ({ ok: false, status: 401, async json() { return { ok: false }; } });
  try {
    await assert.rejects(
      cronHandler.sendTelegramSignal('XAU/USD', { direction: 'BUY', tradePlan: {} }, 'https://aurum-signals-ai.vercel.app'),
      error => !error.message.includes('secret-token-value') && /HTTP 401/.test(error.message)
    );
  } finally {
    if (oldToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN; else process.env.TELEGRAM_BOT_TOKEN = oldToken;
    if (oldChat === undefined) delete process.env.TELEGRAM_CHAT_ID; else process.env.TELEGRAM_CHAT_ID = oldChat;
    global.fetch = oldFetch;
  }
});
