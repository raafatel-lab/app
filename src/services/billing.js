const db = require('../db');
const payments = require('../db/payments');

const getUser = db.prepare('SELECT * FROM users WHERE id = ?');
const changeBalance = db.prepare(
  "UPDATE users SET balance_cents = balance_cents + ?, updated_at = datetime('now') WHERE id = ?",
);
const insertTx = db.prepare(
  `INSERT INTO transactions (user_id, type, amount_cents, balance_after, comment)
   VALUES (?, ?, ?, ?, ?)`,
);

// Общая точка изменения баланса: меняем баланс и пишем строку в журнал.
const applyBalance = db.transaction((userId, amountCents, type, comment) => {
  const user = getUser.get(userId);
  if (!user) throw new Error('USER_NOT_FOUND');
  const next = user.balance_cents + amountCents;
  if (next < 0) throw new Error('INSUFFICIENT_FUNDS');

  changeBalance.run(amountCents, userId);
  insertTx.run(userId, type, amountCents, next, comment || '');
  return next;
});

// Зачисление оплаты. Идемпотентно: повторный вебхук/проверка не начислит второй раз.
const creditPayment = db.transaction((paymentId, comment) => {
  const payment = db.prepare('SELECT * FROM payments WHERE id = ?').get(paymentId);
  if (!payment) throw new Error('PAYMENT_NOT_FOUND');
  if (payment.status === 'paid') return { credited: false, payment };

  db.prepare("UPDATE payments SET status = 'paid', paid_at = datetime('now') WHERE id = ?").run(paymentId);
  const balance = applyBalance(
    payment.user_id,
    payment.amount_cents,
    'topup',
    comment || `Пополнение #${paymentId} (${payment.provider})`,
  );
  return { credited: true, payment: payments.getById(paymentId), balance };
});

module.exports = {
  credit: (userId, amountCents, comment = '', type = 'admin') =>
    applyBalance(userId, Math.abs(amountCents), type, comment),

  debit: (userId, amountCents, comment = '', type = 'admin') =>
    applyBalance(userId, -Math.abs(amountCents), type, comment),

  creditPayment,

  history: (userId, limit = 10) =>
    db.prepare('SELECT * FROM transactions WHERE user_id = ? ORDER BY id DESC LIMIT ?').all(userId, limit),
};
