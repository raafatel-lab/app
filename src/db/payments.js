const db = require('./index');

module.exports = {
  create: ({ userId, provider, amountCents, externalId = null, payUrl = null, meta = {} }) => {
    const info = db
      .prepare(
        `INSERT INTO payments (user_id, provider, external_id, amount_cents, pay_url, meta)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(userId, provider, externalId, amountCents, payUrl, JSON.stringify(meta));
    return info.lastInsertRowid;
  },

  getById: (id) => db.prepare('SELECT * FROM payments WHERE id = ?').get(id),

  getByExternalId: (provider, externalId) =>
    db.prepare('SELECT * FROM payments WHERE provider = ? AND external_id = ?').get(provider, String(externalId)),

  setExternalId: (id, externalId, payUrl) =>
    db.prepare('UPDATE payments SET external_id = ?, pay_url = ? WHERE id = ?').run(String(externalId), payUrl, id),

  setStatus: (id, status) => db.prepare('UPDATE payments SET status = ? WHERE id = ?').run(status, id),

  listPending: (userId) =>
    db
      .prepare("SELECT * FROM payments WHERE user_id = ? AND status = 'pending' ORDER BY id DESC")
      .all(userId),

  listPendingManual: (limit = 20) =>
    db
      .prepare("SELECT * FROM payments WHERE status = 'pending' AND provider = 'manual' ORDER BY id DESC LIMIT ?")
      .all(limit),

  stats: () =>
    db
      .prepare(
        `SELECT COUNT(*) AS paid_count, COALESCE(SUM(amount_cents), 0) AS paid_cents
         FROM payments WHERE status = 'paid'`,
      )
      .get(),
};
