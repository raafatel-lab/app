const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

// Тесты работают на отдельной временной базе.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'shop-test-'));
process.env.DB_PATH = path.join(tmpDir, 'test.db');
process.env.BOT_TOKEN = 'test';

const db = require('../src/db');
const usersRepo = require('../src/db/users');
const productsRepo = require('../src/db/products');
const paymentsRepo = require('../src/db/payments');
const ordersRepo = require('../src/db/orders');
const billing = require('../src/services/billing');
const shop = require('../src/services/shop');
const money = require('../src/utils/money');

let seq = 0;
function makeUser(balanceCents = 0) {
  seq += 1;
  const user = usersRepo.upsertFromTelegram({ id: 1000 + seq, username: `user${seq}`, first_name: 'Test' });
  if (balanceCents) billing.credit(user.id, balanceCents, 'seed');
  return usersRepo.getById(user.id);
}

function makeProduct(priceCents, links) {
  const id = productsRepo.create({ title: `Товар ${++seq}`, priceCents });
  productsRepo.addItems(id, links);
  return id;
}

test('покупка списывает баланс и выдаёт ссылки', () => {
  const user = makeUser(30000);
  const productId = makeProduct(10000, ['https://a.test/1', 'https://a.test/2', 'https://a.test/3']);

  const result = shop.purchase(user.id, productId, 2);

  assert.strictEqual(result.totalCents, 20000);
  assert.deepStrictEqual(result.payloads, ['https://a.test/1', 'https://a.test/2']);
  assert.strictEqual(usersRepo.getById(user.id).balance_cents, 10000);
  assert.strictEqual(productsRepo.stock(productId), 1);

  const order = ordersRepo.getById(result.orderId);
  assert.strictEqual(order.quantity, 2);
  assert.strictEqual(order.unit_price_cents, 10000);
  assert.strictEqual(ordersRepo.itemsOfOrder(result.orderId).length, 2);
});

test('покупка без денег ничего не меняет', () => {
  const user = makeUser(5000);
  const productId = makeProduct(10000, ['https://b.test/1']);

  assert.throws(() => shop.purchase(user.id, productId, 1), /INSUFFICIENT_FUNDS/);
  assert.strictEqual(usersRepo.getById(user.id).balance_cents, 5000);
  assert.strictEqual(productsRepo.stock(productId), 1, 'ссылка осталась на складе');
});

test('нельзя купить больше, чем есть на складе', () => {
  const user = makeUser(100000);
  const productId = makeProduct(1000, ['https://c.test/1', 'https://c.test/2']);

  assert.throws(() => shop.purchase(user.id, productId, 3), /OUT_OF_STOCK/);

  shop.purchase(user.id, productId, 2);
  assert.strictEqual(productsRepo.stock(productId), 0);
  assert.throws(() => shop.purchase(user.id, productId, 1), /OUT_OF_STOCK/);
});

test('одна ссылка не может уйти двум покупателям', () => {
  const first = makeUser(10000);
  const second = makeUser(10000);
  const productId = makeProduct(1000, ['https://d.test/only']);

  const result = shop.purchase(first.id, productId, 1);
  assert.throws(() => shop.purchase(second.id, productId, 1), /OUT_OF_STOCK/);
  assert.strictEqual(ordersRepo.itemsOfOrder(result.orderId)[0].payload, 'https://d.test/only');
  assert.strictEqual(usersRepo.getById(second.id).balance_cents, 10000);
});

test('скрытый товар купить нельзя', () => {
  const user = makeUser(10000);
  const productId = makeProduct(1000, ['https://e.test/1']);
  productsRepo.update(productId, { is_active: 0 });

  assert.throws(() => shop.purchase(user.id, productId, 1), /PRODUCT_UNAVAILABLE/);
});

test('оплата зачисляется один раз', () => {
  const user = makeUser(0);
  const paymentId = paymentsRepo.create({ userId: user.id, provider: 'cryptobot', amountCents: 50000 });

  const first = billing.creditPayment(paymentId);
  const second = billing.creditPayment(paymentId);

  assert.strictEqual(first.credited, true);
  assert.strictEqual(second.credited, false, 'повторный вебхук не начисляет второй раз');
  assert.strictEqual(usersRepo.getById(user.id).balance_cents, 50000);
  assert.strictEqual(paymentsRepo.getById(paymentId).status, 'paid');
});

test('каждое движение баланса попадает в журнал', () => {
  const user = makeUser(20000);
  const productId = makeProduct(5000, ['https://f.test/1']);
  shop.purchase(user.id, productId, 1);

  const history = billing.history(user.id, 10);
  assert.strictEqual(history[0].type, 'purchase');
  assert.strictEqual(history[0].amount_cents, -5000);
  assert.strictEqual(history[0].balance_after, 15000);
});

test('суммы разбираются и печатаются корректно', () => {
  assert.strictEqual(money.parseAmount('150'), 15000);
  assert.strictEqual(money.parseAmount('150,50'), 15050);
  assert.strictEqual(money.parseAmount('0.99'), 99);
  assert.strictEqual(money.parseAmount('abc'), null);
  assert.strictEqual(money.parseAmount('1.999'), null);
  assert.match(money.format(15050), /^150\.50 /);
  assert.match(money.format(15000), /^150 /);
});

test.after(() => {
  db.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});
