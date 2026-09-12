const db = require('../db');
const billing = require('./billing');

const selectProduct = db.prepare('SELECT * FROM products WHERE id = ?');
const selectFreeItems = db.prepare(
  `SELECT id, payload FROM product_items
   WHERE product_id = ? AND status = 'available' ORDER BY id LIMIT ?`,
);
const markSold = db.prepare(
  "UPDATE product_items SET status = 'sold', order_id = ?, sold_at = datetime('now') WHERE id = ?",
);
const insertOrder = db.prepare(
  `INSERT INTO orders (user_id, product_id, quantity, unit_price_cents, total_cents)
   VALUES (?, ?, ?, ?, ?)`,
);

// Покупка целиком в одной транзакции: и списание денег, и выдача ссылок,
// иначе при гонке два человека могли бы купить одну и ту же ссылку.
const purchase = db.transaction((userId, productId, quantity) => {
  const product = selectProduct.get(productId);
  if (!product || !product.is_active) throw new Error('PRODUCT_UNAVAILABLE');
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error('BAD_QUANTITY');

  const items = selectFreeItems.all(productId, quantity);
  if (items.length < quantity) throw new Error('OUT_OF_STOCK');

  const total = product.price_cents * quantity;
  billing.debit(userId, total, `Покупка: ${product.title} x${quantity}`, 'purchase');

  const orderId = insertOrder.run(userId, productId, quantity, product.price_cents, total).lastInsertRowid;
  for (const item of items) markSold.run(orderId, item.id);

  return {
    orderId,
    product,
    quantity,
    totalCents: total,
    payloads: items.map((i) => i.payload),
  };
});

module.exports = { purchase };
