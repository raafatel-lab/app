const crypto = require('crypto');
const config = require('../config');
const money = require('../utils/money');

// Crypto Pay API (@CryptoBot). Счёт выставляется в фиате (валюта магазина),
// а платит пользователь любой поддерживаемой криптой — курс считает сам CryptoBot.
async function call(method, params = {}, httpMethod = 'POST') {
  if (!config.cryptoBot.enabled) throw new Error('CRYPTOBOT_DISABLED');

  let url = `${config.cryptoBot.apiUrl}/${method}`;
  const options = {
    method: httpMethod,
    headers: { 'Crypto-Pay-API-Token': config.cryptoBot.token },
  };

  if (httpMethod === 'GET') {
    const query = new URLSearchParams(params).toString();
    if (query) url += `?${query}`;
  } else {
    options.headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(params);
  }

  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || !data.ok) {
    const reason = data.error ? JSON.stringify(data.error) : `HTTP ${res.status}`;
    throw new Error(`CryptoBot ${method} failed: ${reason}`);
  }
  return data.result;
}

async function createInvoice({ amountCents, paymentId, description }) {
  const params = {
    currency_type: 'fiat',
    fiat: config.currency,
    amount: String(money.toMajor(amountCents)),
    description: description || `Пополнение баланса #${paymentId}`,
    payload: String(paymentId),
    expires_in: config.cryptoBot.invoiceTtlSeconds,
    allow_comments: false,
    allow_anonymous: false,
  };
  if (config.cryptoBot.assets.length) params.accepted_assets = config.cryptoBot.assets.join(',');

  const invoice = await call('createInvoice', params);
  return {
    externalId: String(invoice.invoice_id),
    payUrl: invoice.bot_invoice_url || invoice.pay_url || invoice.mini_app_invoice_url,
    raw: invoice,
  };
}

async function getInvoice(externalId) {
  const result = await call('getInvoices', { invoice_ids: String(externalId) }, 'GET');
  const items = Array.isArray(result) ? result : result.items || [];
  return items[0] || null;
}

async function isPaid(externalId) {
  const invoice = await getInvoice(externalId);
  return Boolean(invoice && invoice.status === 'paid');
}

// Подпись вебхука: HMAC-SHA256 сырого тела ключом SHA256(token).
function verifyWebhook(rawBody, signature) {
  if (!config.cryptoBot.enabled || !signature) return false;
  const secret = crypto.createHash('sha256').update(config.cryptoBot.token).digest();
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(String(signature), 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { createInvoice, getInvoice, isPaid, verifyWebhook, call };
