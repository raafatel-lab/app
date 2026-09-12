const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');

// Crypto Pay API поднимаем локальной заглушкой: проверяем, что клиент шлёт
// правильный запрос, а вебхук зачисляет деньги ровно один раз.
const TOKEN = 'test-token:secret';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-pay-'));

let mock;
let mockRequests = [];
let app;
let appServer;
let appUrl;
let mod = {};

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

test.before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      mockRequests.push({ url: req.url, token: req.headers['crypto-pay-api-token'], body: body ? JSON.parse(body) : null });
      res.setHeader('Content-Type', 'application/json');

      if (req.url.startsWith('/createInvoice')) {
        return res.end(JSON.stringify({
          ok: true,
          result: { invoice_id: 777, status: 'active', bot_invoice_url: 'https://t.me/CryptoBot?start=inv777' },
        }));
      }
      if (req.url.startsWith('/getInvoices')) {
        return res.end(JSON.stringify({ ok: true, result: { items: [{ invoice_id: 777, status: 'active' }] } }));
      }
      return res.end(JSON.stringify({ ok: false, error: { code: 404 } }));
    });
  });
  const mockPort = await listen(mock);

  process.env.DB_PATH = path.join(tmpDir, 'pay.db');
  process.env.BOT_TOKEN = 'test';
  process.env.CRYPTO_PAY_TOKEN = TOKEN;
  process.env.CRYPTO_PAY_API_URL = `http://127.0.0.1:${mockPort}`;
  process.env.CRYPTO_PAY_ASSETS = 'USDT,TON';
  process.env.CURRENCY = 'RUB';

  mod.usersRepo = require('../src/db/users');
  mod.paymentsRepo = require('../src/db/payments');
  mod.paymentsService = require('../src/payments');
  mod.db = require('../src/db');

  app = require('../src/server').createServer(null);
  appServer = http.createServer(app);
  const appPort = await listen(appServer);
  appUrl = `http://127.0.0.1:${appPort}`;
});

function sign(rawBody) {
  const secret = crypto.createHash('sha256').update(TOKEN).digest();
  return crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
}

function postWebhook(payload, signature) {
  const raw = JSON.stringify(payload);
  return fetch(`${appUrl}/webhook/cryptobot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'crypto-pay-api-signature': signature ?? sign(raw) },
    body: raw,
  });
}

test('счёт выставляется в валюте магазина и сохраняется в базе', async () => {
  const user = mod.usersRepo.upsertFromTelegram({ id: 5001, username: 'payer', first_name: 'Payer' });
  mockRequests = [];

  const payment = await mod.paymentsService.createTopup({ user, amountCents: 150000, method: 'cryptobot' });

  const request = mockRequests.find((r) => r.url.startsWith('/createInvoice'));
  assert.strictEqual(request.token, TOKEN, 'токен уходит в заголовке');
  assert.strictEqual(request.body.currency_type, 'fiat');
  assert.strictEqual(request.body.fiat, 'RUB');
  assert.strictEqual(request.body.amount, '1500', 'сумма в рублях, а не в копейках');
  assert.strictEqual(request.body.accepted_assets, 'USDT,TON');
  assert.strictEqual(request.body.payload, String(payment.id), 'по payload находим свой счёт');

  assert.strictEqual(payment.external_id, '777');
  assert.strictEqual(payment.pay_url, 'https://t.me/CryptoBot?start=inv777');
  assert.strictEqual(payment.status, 'pending');
});

test('неоплаченный счёт баланс не трогает', async () => {
  const user = mod.usersRepo.getByTelegramId(5001);
  const payment = mod.paymentsRepo.listPending(user.id)[0];

  const result = await mod.paymentsService.checkAndCredit(payment.id);

  assert.strictEqual(result.status, 'pending');
  assert.strictEqual(mod.usersRepo.getById(user.id).balance_cents, 0);
});

test('вебхук без правильной подписи отвергается', async () => {
  const user = mod.usersRepo.getByTelegramId(5001);
  const payment = mod.paymentsRepo.listPending(user.id)[0];

  const res = await postWebhook(
    { update_type: 'invoice_paid', payload: { invoice_id: 777, payload: String(payment.id) } },
    'deadbeef',
  );

  assert.strictEqual(res.status, 401);
  assert.strictEqual(mod.usersRepo.getById(user.id).balance_cents, 0, 'деньги не начислены');
});

test('подписанный вебхук зачисляет деньги один раз', async () => {
  const user = mod.usersRepo.getByTelegramId(5001);
  const payment = mod.paymentsRepo.listPending(user.id)[0];
  const update = { update_type: 'invoice_paid', payload: { invoice_id: 777, payload: String(payment.id) } };

  const first = await postWebhook(update);
  assert.strictEqual(first.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(mod.usersRepo.getById(user.id).balance_cents, 150000);
  assert.strictEqual(mod.paymentsRepo.getById(payment.id).status, 'paid');

  // повторная доставка того же события — деньги не удваиваются
  const second = await postWebhook(update);
  assert.strictEqual(second.status, 200);
  await new Promise((r) => setTimeout(r, 50));
  assert.strictEqual(mod.usersRepo.getById(user.id).balance_cents, 150000);
});

test('чужие события игнорируются без падения', async () => {
  const res = await postWebhook({ update_type: 'invoice_paid', payload: { invoice_id: 999, payload: '424242' } });
  assert.strictEqual(res.status, 200);
});

test('ручной криптоперевод: хеш сохраняется, зачисление одноразовое', () => {
  const user = mod.usersRepo.upsertFromTelegram({ id: 5002, username: 'manual', first_name: 'Manual' });
  const paymentId = mod.paymentsRepo.create({
    userId: user.id, provider: 'manual', amountCents: 30000, meta: { telegram_id: user.telegram_id },
  });

  mod.paymentsRepo.mergeMeta(paymentId, { tx: '0xabc123' });
  const stored = JSON.parse(mod.paymentsRepo.getById(paymentId).meta);
  assert.strictEqual(stored.tx, '0xabc123');
  assert.strictEqual(stored.telegram_id, user.telegram_id, 'прежние поля meta не затёрты');

  assert.strictEqual(mod.paymentsRepo.listPendingManual(10).some((p) => p.id === paymentId), true);

  const first = mod.paymentsService.approveManual(paymentId, 777);
  assert.strictEqual(first.credited, true);
  assert.strictEqual(mod.usersRepo.getById(user.id).balance_cents, 30000);

  const second = mod.paymentsService.approveManual(paymentId, 777);
  assert.strictEqual(second.credited, false, 'повторное подтверждение не удваивает баланс');
  assert.strictEqual(mod.usersRepo.getById(user.id).balance_cents, 30000);
});

test.after(() => {
  mock.close();
  appServer.close();
  mod.db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
