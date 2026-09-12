const db = require('./index');

const selectByTelegramId = db.prepare('SELECT * FROM users WHERE telegram_id = ?');
const selectById = db.prepare('SELECT * FROM users WHERE id = ?');
const insertUser = db.prepare(`
  INSERT INTO users (telegram_id, username, first_name)
  VALUES (@telegram_id, @username, @first_name)
`);
const updateProfile = db.prepare(`
  UPDATE users SET username = @username, first_name = @first_name, updated_at = datetime('now')
  WHERE id = @id
`);

function upsertFromTelegram(from) {
  const telegramId = Number(from.id);
  const username = from.username || null;
  const firstName = from.first_name || null;

  const existing = selectByTelegramId.get(telegramId);
  if (!existing) {
    insertUser.run({ telegram_id: telegramId, username, first_name: firstName });
    return selectByTelegramId.get(telegramId);
  }

  if (existing.username !== username || existing.first_name !== firstName) {
    updateProfile.run({ id: existing.id, username, first_name: firstName });
    return selectByTelegramId.get(telegramId);
  }
  return existing;
}

module.exports = {
  upsertFromTelegram,
  getByTelegramId: (telegramId) => selectByTelegramId.get(Number(telegramId)),
  getById: (id) => selectById.get(id),
  setBlocked: (id, blocked) =>
    db.prepare("UPDATE users SET is_blocked = ?, updated_at = datetime('now') WHERE id = ?").run(blocked ? 1 : 0, id),
  count: () => db.prepare('SELECT COUNT(*) AS c FROM users').get().c,
  listRecent: (limit = 10) =>
    db.prepare('SELECT * FROM users ORDER BY id DESC LIMIT ?').all(limit),
  search: (query) => {
    const asId = Number(query);
    if (Number.isInteger(asId) && asId > 0) {
      const byTelegram = selectByTelegramId.get(asId);
      if (byTelegram) return byTelegram;
    }
    const username = String(query).replace(/^@/, '');
    return db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE').get(username);
  },
};
