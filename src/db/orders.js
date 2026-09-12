const db = require('./index');

module.exports = {
  listByUser: (userId, limit = 10) =>
    db
      .prepare(
        `SELECT o.*, p.title
         FROM orders o JOIN products p ON p.id = o.product_id
         WHERE o.user_id = ? ORDER BY o.id DESC LIMIT ?`,
      )
      .all(userId, limit),

  getById: (id) =>
    db
      .prepare(
        `SELECT o.*, p.title FROM orders o JOIN products p ON p.id = o.product_id WHERE o.id = ?`,
      )
      .get(id),

  itemsOfOrder: (orderId) =>
    db.prepare('SELECT payload FROM product_items WHERE order_id = ? ORDER BY id').all(orderId),

  stats: () =>
    db
      .prepare(
        `SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS revenue_cents,
                COALESCE(SUM(quantity), 0) AS items
         FROM orders`,
      )
      .get(),
};
