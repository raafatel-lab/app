const config = require('../config');

async function notifyAdmins(telegram, text, extra = {}) {
  for (const adminId of config.admins) {
    try {
      await telegram.sendMessage(adminId, text, { parse_mode: 'HTML', ...extra });
    } catch (err) {
      console.error(`[notify] не доставлено админу ${adminId}:`, err.message);
    }
  }
}

async function notifyUser(telegram, telegramId, text, extra = {}) {
  try {
    await telegram.sendMessage(telegramId, text, { parse_mode: 'HTML', ...extra });
    return true;
  } catch (err) {
    console.error(`[notify] не доставлено пользователю ${telegramId}:`, err.message);
    return false;
  }
}

module.exports = { notifyAdmins, notifyUser };
