const { Markup } = require('telegraf');
const config = require('../config');

const BTN = {
  catalog: '🛍 Каталог',
  profile: '👤 Профиль',
  topup: '💳 Пополнить баланс',
  orders: '📦 Мои покупки',
  help: 'ℹ️ Помощь',
  admin: '🛠 Админка',
};

function mainMenu(telegramId) {
  const rows = [
    [BTN.catalog, BTN.profile],
    [BTN.topup, BTN.orders],
    [BTN.help],
  ];
  if (config.isAdmin(telegramId)) rows.push([BTN.admin]);
  return Markup.keyboard(rows).resize();
}

function backTo(action, label = '⬅️ Назад') {
  return Markup.inlineKeyboard([[Markup.button.callback(label, action)]]);
}

module.exports = { BTN, mainMenu, backTo };
