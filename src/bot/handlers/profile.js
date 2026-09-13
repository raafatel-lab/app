const { Markup } = require('telegraf');
const { BTN } = require('../keyboards');
const money = require('../../utils/money');
const db = require('../../db');
const ordersRepo = require('../../db/orders');
const billing = require('../../services/billing');
const { ACTIVATION_HINT } = require('../texts');

const TX_LABEL = {
  topup: '➕ Пополнение',
  purchase: '🛒 Покупка',
  refund: '↩️ Возврат',
  admin: '⚙️ Корректировка',
};

function profileText(user) {
  const stats = db
    .prepare(
      `SELECT COUNT(*) AS orders, COALESCE(SUM(total_cents), 0) AS spent, COALESCE(SUM(quantity), 0) AS items
       FROM orders WHERE user_id = ?`,
    )
    .get(user.id);

  return [
    '👤 <b>Профиль</b>',
    '',
    `ID: <code>${user.telegram_id}</code>`,
    user.username ? `Логин: @${user.username}` : null,
    `Баланс: <b>${money.format(user.balance_cents)}</b>`,
    '',
    `Покупок: ${stats.orders} (товаров: ${stats.items})`,
    `Потрачено: ${money.format(stats.spent)}`,
    `В магазине с: ${user.created_at}`,
  ]
    .filter(Boolean)
    .join('\n');
}

function profileKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback('💳 Пополнить баланс', 'topup:start')],
    [Markup.button.callback('📜 История операций', 'profile:history')],
    [Markup.button.callback('📦 Мои покупки', 'orders:list')],
  ]);
}

function ordersText(user) {
  const orders = ordersRepo.listByUser(user.id, 10);
  if (!orders.length) return '📦 Покупок пока нет. Загляни в каталог!';

  const lines = orders.map(
    (o) =>
      `#${o.id} · ${o.title} · ${o.quantity} шт · ${money.format(o.total_cents)}\n<i>${o.created_at}</i>`,
  );
  return ['📦 <b>Последние покупки</b>', '', lines.join('\n\n')].join('\n');
}

function ordersKeyboard(user) {
  const orders = ordersRepo.listByUser(user.id, 10);
  const rows = orders.map((o) => [Markup.button.callback(`🔗 Ссылки заказа #${o.id}`, `orders:show:${o.id}`)]);
  return Markup.inlineKeyboard(rows);
}

function register(bot) {
  const showProfile = (ctx) =>
    ctx.reply(profileText(ctx.state.user), { parse_mode: 'HTML', ...profileKeyboard() });

  bot.hears(BTN.profile, showProfile);
  bot.command('profile', showProfile);
  bot.command('balance', (ctx) => ctx.reply(`Баланс: <b>${money.format(ctx.state.user.balance_cents)}</b>`, { parse_mode: 'HTML' }));

  bot.action('profile:history', async (ctx) => {
    await ctx.answerCbQuery();
    const rows = billing.history(ctx.state.user.id, 15);
    if (!rows.length) return ctx.reply('Операций пока не было.');

    const text = rows
      .map((t) => {
        const sign = t.amount_cents > 0 ? '+' : '−';
        return `${TX_LABEL[t.type] || t.type} ${sign}${money.format(Math.abs(t.amount_cents))}\n<i>${t.created_at}${t.comment ? ` · ${t.comment}` : ''}</i>`;
      })
      .join('\n\n');
    return ctx.reply(['📜 <b>История операций</b>', '', text].join('\n'), { parse_mode: 'HTML' });
  });

  const showOrders = (ctx) =>
    ctx.reply(ordersText(ctx.state.user), { parse_mode: 'HTML', ...ordersKeyboard(ctx.state.user) });

  bot.hears(BTN.orders, showOrders);
  bot.command('orders', showOrders);
  bot.action('orders:list', async (ctx) => {
    await ctx.answerCbQuery();
    return showOrders(ctx);
  });

  bot.action(/^orders:show:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const orderId = Number(ctx.match[1]);
    const order = ordersRepo.getById(orderId);
    if (!order || order.user_id !== ctx.state.user.id) return ctx.reply('Заказ не найден.');

    const items = ordersRepo.itemsOfOrder(orderId);
    const payloads = items.map((i) => `<code>${escapeHtml(i.payload)}</code>`).join('\n');
    return ctx.reply(
      [`🔗 <b>Заказ #${order.id}</b> · ${escapeHtml(order.title)}`, '', payloads, '', ACTIVATION_HINT].join('\n'),
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    );
  });
}

function escapeHtml(text) {
  return String(text).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
}

module.exports = { register, profileText, escapeHtml };
