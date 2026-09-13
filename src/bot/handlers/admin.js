const { Markup } = require('telegraf');
const config = require('../../config');
const { BTN } = require('../keyboards');
const money = require('../../utils/money');
const db = require('../../db');
const usersRepo = require('../../db/users');
const productsRepo = require('../../db/products');
const ordersRepo = require('../../db/orders');
const paymentsRepo = require('../../db/payments');
const billing = require('../../services/billing');
const paymentsService = require('../../payments');
const prompts = require('../prompts');
const { notifyUser } = require('../notify');
const { escapeHtml } = require('./profile');

function isAdmin(ctx) {
  return config.isAdmin(ctx.from && ctx.from.id);
}

function menuView() {
  return {
    text: '🛠 <b>Панель управления</b>',
    keyboard: Markup.inlineKeyboard([
      [Markup.button.callback('📦 Товары', 'adm:products')],
      [Markup.button.callback('💰 Заявки на пополнение', 'adm:pays')],
      [Markup.button.callback('👥 Пользователи', 'adm:users')],
      [Markup.button.callback('📊 Статистика', 'adm:stats')],
    ]),
  };
}

function productsView() {
  const products = productsRepo.listAll();
  const rows = products.map((p) => [
    Markup.button.callback(
      `${p.is_active ? '🟢' : '⚪️'} ${p.title} · ${money.format(p.price_cents)} · ${p.stock} шт`,
      `adm:p:${p.id}`,
    ),
  ]);
  rows.push([Markup.button.callback('➕ Новый товар', 'adm:newp')]);
  rows.push([Markup.button.callback('⬅️ Назад', 'adm:menu')]);

  return {
    text: products.length ? '📦 <b>Товары</b>' : '📦 Товаров пока нет.',
    keyboard: Markup.inlineKeyboard(rows),
  };
}

function productView(id) {
  const p = productsRepo.getById(id);
  if (!p) return null;

  const sold = db.prepare('SELECT COALESCE(SUM(quantity), 0) AS c FROM orders WHERE product_id = ?').get(id).c;

  return {
    text: [
      `📦 <b>${escapeHtml(p.title)}</b> (id ${p.id})`,
      p.description ? escapeHtml(p.description) : '<i>без описания</i>',
      '',
      `Цена за единицу: <b>${money.format(p.price_cents)}</b>`,
      `В наличии: <b>${p.stock} шт</b> · продано: ${sold}`,
      `Статус: ${p.is_active ? '🟢 в продаже' : '⚪️ скрыт'}`,
    ].join('\n'),
    keyboard: Markup.inlineKeyboard([
      [
        Markup.button.callback('➕ Добавить ссылки', `adm:stock:${p.id}`),
        Markup.button.callback('🔗 Склад', `adm:items:${p.id}:0`),
      ],
      [
        Markup.button.callback('💰 Цена', `adm:price:${p.id}`),
        Markup.button.callback('✏️ Название', `adm:title:${p.id}`),
        Markup.button.callback('📝 Описание', `adm:desc:${p.id}`),
      ],
      [
        Markup.button.callback(p.is_active ? '⚪️ Скрыть' : '🟢 В продажу', `adm:toggle:${p.id}`),
        Markup.button.callback('🗑 Удалить', `adm:del:${p.id}`),
      ],
      [Markup.button.callback('⬅️ К товарам', 'adm:products')],
    ]),
  };
}

const ITEMS_PAGE = 8;

// Склад товара: список непроданных ссылок с удалением по одной.
function itemsView(productId, offset) {
  const product = productsRepo.getById(productId);
  if (!product) return null;

  const items = productsRepo.listAvailableItems(productId, ITEMS_PAGE, offset);
  if (!items.length && offset > 0) return itemsView(productId, 0);

  const lines = items.map((i, n) => `${offset + n + 1}. <code>${escapeHtml(i.payload)}</code>`);
  const rows = items.map((i, n) => [
    Markup.button.callback(`🗑 убрать #${offset + n + 1}`, `adm:delitem:${i.id}:${offset}`),
  ]);

  const nav = [];
  if (offset > 0) nav.push(Markup.button.callback('⬅️', `adm:items:${productId}:${Math.max(0, offset - ITEMS_PAGE)}`));
  if (offset + ITEMS_PAGE < product.stock) {
    nav.push(Markup.button.callback('➡️', `adm:items:${productId}:${offset + ITEMS_PAGE}`));
  }
  if (nav.length) rows.push(nav);
  rows.push([Markup.button.callback('⬅️ К товару', `adm:p:${productId}`)]);

  return {
    text: [
      `🔗 <b>Склад: ${escapeHtml(product.title)}</b>`,
      `Непроданных ссылок: ${product.stock}`,
      '',
      lines.length ? lines.join('\n') : 'Склад пуст — добавь ссылки кнопкой «➕ Добавить ссылки».',
      '',
      '<i>Удаляются только непроданные ссылки. Выданные покупателям остаются в их заказах.</i>',
    ].join('\n'),
    keyboard: Markup.inlineKeyboard(rows),
  };
}

function userView(user) {
  return {
    text: [
      `👤 <code>${user.telegram_id}</code>${user.username ? ` (@${user.username})` : ''}`,
      `Имя: ${escapeHtml(user.first_name || '—')}`,
      `Баланс: <b>${money.format(user.balance_cents)}</b>`,
      `Статус: ${user.is_blocked ? '🚫 заблокирован' : '✅ активен'}`,
      `Регистрация: ${user.created_at}`,
    ].join('\n'),
    keyboard: Markup.inlineKeyboard([
      [
        Markup.button.callback('➕ Начислить', `adm:bal:${user.id}:add`),
        Markup.button.callback('➖ Списать', `adm:bal:${user.id}:sub`),
      ],
      [
        Markup.button.callback(user.is_blocked ? '✅ Разблокировать' : '🚫 Заблокировать', `adm:block:${user.id}`),
      ],
      [Markup.button.callback('⬅️ Назад', 'adm:menu')],
    ]),
  };
}

function paysView() {
  const pending = paymentsRepo.listPendingManual(20);
  if (!pending.length) {
    return { text: '💰 Заявок на ручное пополнение нет.', keyboard: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'adm:menu')]]) };
  }

  const lines = [];
  const rows = pending.map((p) => {
    const user = usersRepo.getById(p.user_id);
    let tx = '';
    try {
      tx = (JSON.parse(p.meta) || {}).tx || '';
    } catch {
      tx = '';
    }

    lines.push(
      [
        `#${p.id} · ${money.format(p.amount_cents)} · ${p.created_at}`,
        `от <code>${user ? user.telegram_id : '?'}</code>${user && user.username ? ` (@${user.username})` : ''}`,
        tx ? `хеш: <code>${escapeHtml(tx)}</code>` : 'хеш не указан',
      ].join('\n'),
    );

    return [
      Markup.button.callback(`#${p.id} · ${money.format(p.amount_cents)}`, 'noop'),
      Markup.button.callback('✅', `adm:payok:${p.id}`),
      Markup.button.callback('❌', `adm:payno:${p.id}`),
    ];
  });
  rows.push([Markup.button.callback('⬅️ Назад', 'adm:menu')]);

  return {
    text: ['💰 <b>Заявки на пополнение</b>', '', lines.join('\n\n')].join('\n'),
    keyboard: Markup.inlineKeyboard(rows),
  };
}

function statsView() {
  const orders = ordersRepo.stats();
  const pays = paymentsRepo.stats();
  const balances = db.prepare('SELECT COALESCE(SUM(balance_cents), 0) AS c FROM users').get().c;

  return {
    text: [
      '📊 <b>Статистика</b>',
      '',
      `Пользователей: ${usersRepo.count()}`,
      `Заказов: ${orders.orders} (товаров: ${orders.items})`,
      `Выручка: ${money.format(orders.revenue_cents)}`,
      `Пополнений: ${pays.paid_count} на ${money.format(pays.paid_cents)}`,
      `Балансы пользователей: ${money.format(balances)}`,
      `Ссылок на складе: ${productsRepo.totalStock()}`,
    ].join('\n'),
    keyboard: Markup.inlineKeyboard([[Markup.button.callback('⬅️ Назад', 'adm:menu')]]),
  };
}

async function edit(ctx, view) {
  await ctx
    .editMessageText(view.text, { parse_mode: 'HTML', ...view.keyboard })
    .catch(() => ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard }));
}

function register(bot) {
  // Все админские действия проходят через одну проверку прав.
  bot.use(async (ctx, next) => {
    const data = ctx.callbackQuery && ctx.callbackQuery.data;
    if (data && data.startsWith('adm:') && !isAdmin(ctx)) return ctx.answerCbQuery('Недоступно.');
    return next();
  });

  const showMenu = (ctx) => {
    if (!isAdmin(ctx)) return undefined;
    const view = menuView();
    return ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard });
  };

  bot.hears(BTN.admin, showMenu);
  bot.command('admin', showMenu);

  bot.action('adm:menu', async (ctx) => {
    await ctx.answerCbQuery();
    return edit(ctx, menuView());
  });

  bot.action('adm:products', async (ctx) => {
    await ctx.answerCbQuery();
    return edit(ctx, productsView());
  });

  bot.action('adm:stats', async (ctx) => {
    await ctx.answerCbQuery();
    return edit(ctx, statsView());
  });

  bot.action('adm:pays', async (ctx) => {
    await ctx.answerCbQuery();
    return edit(ctx, paysView());
  });

  bot.action(/^adm:p:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const view = productView(Number(ctx.match[1]));
    if (!view) return ctx.reply('Товар не найден.');
    return edit(ctx, view);
  });

  // --- создание и редактирование товара ---
  bot.action('adm:newp', async (ctx) => {
    await ctx.answerCbQuery();
    prompts.ask(ctx, 'adm_newp');
    return ctx.reply(
      [
        '➕ <b>Новый товар</b>',
        '',
        'Пришли одной строкой: <code>Название | цена | описание</code>',
        'Например: <code>Ссылки на канал | 150 | Вечная ссылка, выдача сразу</code>',
        'Описание можно не указывать.',
      ].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  prompts.register('adm_newp', async (ctx) => {
    const [title, price, ...rest] = ctx.message.text.split('|').map((s) => s.trim());
    const priceCents = money.parseAmount(price || '');
    if (!title || priceCents === null || priceCents <= 0) {
      return ctx.reply('Формат: Название | цена | описание');
    }

    prompts.clear(ctx);
    const id = productsRepo.create({ title, priceCents, description: rest.join(' | ') });
    await ctx.reply(`✅ Товар создан (id ${id}). Теперь добавь ссылки.`);
    const view = productView(id);
    return ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard });
  });

  bot.action(/^adm:stock:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const productId = Number(ctx.match[1]);
    prompts.ask(ctx, 'adm_stock', { productId });
    return ctx.reply(
      'Пришли ссылки — по одной в строке. Каждая строка = одна единица товара на складе.',
    );
  });

  prompts.register('adm_stock', async (ctx, state) => {
    const payloads = ctx.message.text
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (!payloads.length) return ctx.reply('Пусто. Пришли хотя бы одну ссылку.');

    prompts.clear(ctx);
    productsRepo.addItems(state.productId, payloads);
    await ctx.reply(`✅ Добавлено ${payloads.length} шт.`);
    const view = productView(state.productId);
    return ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard });
  });

  const fieldPrompts = {
    price: { type: 'adm_price', text: 'Пришли новую цену за единицу, например: 250' },
    title: { type: 'adm_title', text: 'Пришли новое название' },
    desc: { type: 'adm_desc', text: 'Пришли новое описание' },
  };

  for (const [key, cfg] of Object.entries(fieldPrompts)) {
    bot.action(new RegExp(`^adm:${key}:(\\d+)$`), async (ctx) => {
      await ctx.answerCbQuery();
      prompts.ask(ctx, cfg.type, { productId: Number(ctx.match[1]) });
      return ctx.reply(cfg.text);
    });
  }

  prompts.register('adm_price', async (ctx, state) => {
    const priceCents = money.parseAmount(ctx.message.text);
    if (priceCents === null || priceCents <= 0) return ctx.reply('Нужно число больше нуля, например: 250');

    prompts.clear(ctx);
    productsRepo.update(state.productId, { price_cents: priceCents });
    const view = productView(state.productId);
    return ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard });
  });

  prompts.register('adm_title', async (ctx, state) => {
    prompts.clear(ctx);
    productsRepo.update(state.productId, { title: ctx.message.text.trim() });
    const view = productView(state.productId);
    return ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard });
  });

  prompts.register('adm_desc', async (ctx, state) => {
    prompts.clear(ctx);
    productsRepo.update(state.productId, { description: ctx.message.text.trim() });
    const view = productView(state.productId);
    return ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard });
  });

  bot.action(/^adm:items:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const view = itemsView(Number(ctx.match[1]), Number(ctx.match[2]));
    if (!view) return ctx.reply('Товар не найден.');
    return edit(ctx, view);
  });

  bot.action(/^adm:delitem:(\d+):(\d+)$/, async (ctx) => {
    const itemId = Number(ctx.match[1]);
    const offset = Number(ctx.match[2]);

    const item = productsRepo.getItem(itemId);
    if (!item) return ctx.answerCbQuery('Ссылка уже удалена.');

    const removed = productsRepo.removeAvailableItem(itemId);
    await ctx.answerCbQuery(removed ? 'Ссылка убрана со склада' : 'Ссылка уже продана — удалить нельзя', {
      show_alert: !removed,
    });
    return edit(ctx, itemsView(item.product_id, offset));
  });

  bot.action(/^adm:toggle:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    const product = productsRepo.getById(id);
    if (!product) return ctx.answerCbQuery('Товар не найден.');

    productsRepo.update(id, { is_active: product.is_active ? 0 : 1 });
    await ctx.answerCbQuery(product.is_active ? 'Скрыт' : 'В продаже');
    return edit(ctx, productView(id));
  });

  bot.action(/^adm:del:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const id = Number(ctx.match[1]);
    return edit(ctx, {
      text: '🗑 Удалить товар вместе со всеми ссылками на складе?',
      keyboard: Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Да, удалить', `adm:delok:${id}`),
          Markup.button.callback('⬅️ Отмена', `adm:p:${id}`),
        ],
      ]),
    });
  });

  bot.action(/^adm:delok:(\d+)$/, async (ctx) => {
    const id = Number(ctx.match[1]);
    try {
      productsRepo.remove(id);
      await ctx.answerCbQuery('Удалено');
    } catch (err) {
      // товар уже участвовал в заказах — снимаем с продажи вместо удаления
      productsRepo.update(id, { is_active: 0 });
      await ctx.answerCbQuery('По товару есть заказы — он скрыт, а не удалён.', { show_alert: true });
    }
    return edit(ctx, productsView());
  });

  // --- пользователи ---
  bot.action('adm:users', async (ctx) => {
    await ctx.answerCbQuery();
    prompts.ask(ctx, 'adm_user');

    const recent = usersRepo.listRecent(5).map((u) => `<code>${u.telegram_id}</code>${u.username ? ` @${u.username}` : ''} · ${money.format(u.balance_cents)}`);
    return ctx.reply(
      ['👥 Пришли Telegram ID или @username пользователя.', '', 'Последние:', ...recent].join('\n'),
      { parse_mode: 'HTML' },
    );
  });

  prompts.register('adm_user', async (ctx) => {
    const user = usersRepo.search(ctx.message.text.trim());
    if (!user) return ctx.reply('Пользователь не найден. Пришли ID или @username.');

    prompts.clear(ctx);
    const view = userView(user);
    return ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard });
  });

  bot.action(/^adm:bal:(\d+):(add|sub)$/, async (ctx) => {
    await ctx.answerCbQuery();
    prompts.ask(ctx, 'adm_balance', { userId: Number(ctx.match[1]), mode: ctx.match[2] });
    return ctx.reply(
      ctx.match[2] === 'add' ? 'Сколько начислить? Например: 500' : 'Сколько списать? Например: 500',
    );
  });

  prompts.register('adm_balance', async (ctx, state) => {
    const amount = money.parseAmount(ctx.message.text);
    if (amount === null || amount <= 0) return ctx.reply('Нужно число больше нуля.');

    prompts.clear(ctx);
    const target = usersRepo.getById(state.userId);
    if (!target) return ctx.reply('Пользователь не найден.');

    try {
      if (state.mode === 'add') {
        billing.credit(target.id, amount, `Начисление администратором ${ctx.from.id}`);
        await notifyUser(
          ctx.telegram,
          target.telegram_id,
          `➕ Баланс пополнен на ${money.format(amount)} администратором.`,
        );
      } else {
        billing.debit(target.id, amount, `Списание администратором ${ctx.from.id}`);
        await notifyUser(ctx.telegram, target.telegram_id, `➖ С баланса списано ${money.format(amount)}.`);
      }
    } catch (err) {
      if (err.message === 'INSUFFICIENT_FUNDS') return ctx.reply('На балансе недостаточно средств для списания.');
      throw err;
    }

    const view = userView(usersRepo.getById(state.userId));
    return ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard });
  });

  bot.action(/^adm:block:(\d+)$/, async (ctx) => {
    const target = usersRepo.getById(Number(ctx.match[1]));
    if (!target) return ctx.answerCbQuery('Пользователь не найден.');

    usersRepo.setBlocked(target.id, !target.is_blocked);
    await ctx.answerCbQuery(target.is_blocked ? 'Разблокирован' : 'Заблокирован');
    return edit(ctx, userView(usersRepo.getById(target.id)));
  });

  // --- ручные пополнения ---
  bot.action(/^adm:payok:(\d+)$/, async (ctx) => {
    const paymentId = Number(ctx.match[1]);
    let result;
    try {
      result = paymentsService.approveManual(paymentId, ctx.from.id);
    } catch (err) {
      return ctx.answerCbQuery('Не удалось зачислить: заявка не найдена или уже обработана.', { show_alert: true });
    }

    await ctx.answerCbQuery(result.credited ? 'Зачислено' : 'Уже было зачислено');
    const user = usersRepo.getById(result.payment.user_id);
    if (result.credited && user) {
      await notifyUser(
        ctx.telegram,
        user.telegram_id,
        `✅ Пополнение #${paymentId} на ${money.format(result.payment.amount_cents)} зачислено.\nБаланс: <b>${money.format(user.balance_cents)}</b>`,
      );
    }
    return ctx.editMessageReplyMarkup(undefined).catch(() => {});
  });

  bot.action(/^adm:payno:(\d+)$/, async (ctx) => {
    const paymentId = Number(ctx.match[1]);
    let payment;
    try {
      payment = paymentsService.rejectManual(paymentId);
    } catch (err) {
      return ctx.answerCbQuery('Заявка не найдена или уже обработана.', { show_alert: true });
    }

    await ctx.answerCbQuery('Отклонено');
    const user = usersRepo.getById(payment.user_id);
    if (user) {
      await notifyUser(ctx.telegram, user.telegram_id, `❌ Пополнение #${paymentId} отклонено оператором.`);
    }
    return ctx.editMessageReplyMarkup(undefined).catch(() => {});
  });
}

module.exports = { register };
