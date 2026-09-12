const db = require('./index');

const stockExpr = `(SELECT COUNT(*) FROM product_items i WHERE i.product_id = p.id AND i.status = 'available')`;

module.exports = {
  create: ({ title, description = '', priceCents, categoryId = null }) => {
    const info = db
      .prepare(`INSERT INTO products (title, description, price_cents, category_id) VALUES (?, ?, ?, ?)`)
      .run(title, description, priceCents, categoryId);
    return info.lastInsertRowid;
  },

  getById: (id) => db.prepare(`SELECT p.*, ${stockExpr} AS stock FROM products p WHERE p.id = ?`).get(id),

  listActive: () =>
    db
      .prepare(`SELECT p.*, ${stockExpr} AS stock FROM products p WHERE p.is_active = 1 ORDER BY p.title`)
      .all(),

  listAll: () => db.prepare(`SELECT p.*, ${stockExpr} AS stock FROM products p ORDER BY p.id DESC`).all(),

  update: (id, fields) => {
    const allowed = ['title', 'description', 'price_cents', 'is_active', 'category_id'];
    const keys = Object.keys(fields).filter((k) => allowed.includes(k));
    if (!keys.length) return;
    const set = keys.map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE products SET ${set}, updated_at = datetime('now') WHERE id = @id`).run({ ...fields, id });
  },

  remove: (id) => db.prepare('DELETE FROM products WHERE id = ?').run(id),

  addItems: (productId, payloads) => {
    const insert = db.prepare(`INSERT INTO product_items (product_id, payload) VALUES (?, ?)`);
    const tx = db.transaction((rows) => {
      for (const payload of rows) insert.run(productId, payload);
    });
    tx(payloads);
    return payloads.length;
  },

  stock: (productId) =>
    db
      .prepare(`SELECT COUNT(*) AS c FROM product_items WHERE product_id = ? AND status = 'available'`)
      .get(productId).c,

  totalStock: () =>
    db.prepare(`SELECT COUNT(*) AS c FROM product_items WHERE status = 'available'`).get().c,
};
