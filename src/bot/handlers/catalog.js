const { Markup } = require('telegraf');
const { BTN } = require('../keyboards');
const money = require('../../utils/money');
const productsRepo = require('../../db/products');
const shop = require('../../services/shop');
const { notifyAdmins } = require('../notify');
const { escapeHtml } = require('./profile');

const MAX_PER_ORDER = 50;

function catalogView() {
  const products = productsRepo.listActive();
  if (!products.length) {
    return { text: '🛍 Каталог пока пуст. Загляни позже.', keyboard: Markup.inlineKeyboard([]) };
  }

  const rows = products.map((p) => [
    Markup.button.callback(
      `${p.title} · ${money.format(p.price_cents)} · ${p.stock > 0 ? `${p.stock} шт` : 'нет'}`,
      `cat:p:${p.id}:1`,
    ),
  ]);

  return {
    text: ['🛍 <b>Каталог</b>', '', 'Цена указана за одну единицу товара.'].join('\n'),
    keyboard: Markup.inlineKeyboard(rows),
  };
}

function productView(productId, quantity) {
  const product = productsRepo.getById(productId);
  if (!product || !product.is_active) return null;

  const qty = Math.max(1, Math.min(quantity, Math.max(product.stock, 1), MAX_PER_ORDER));
  const total = product.price_cents * qty;

  const text = [
    `🔗 <b>${escapeHtml(product.title)}</b>`,
    '',
    product.description ? `${escapeHtml(product.description)}\n` : null,
    `Цена за единицу: <b>${money.format(product.price_cents)}</b>`,
    `Доступно к покупке: <b>${product.stock} шт</b>`,
    '',
    product.stock > 0 ? `Количество: <b>${qty}</b> · К оплате: <b>${money.format(total)}</b>` : '❌ Товара нет в наличии',
  ]
    .filter((v) => v !== null)
    .join('\n');

  const rows = [];
  if (product.stock > 0) {
    rows.push([
      Markup.button.callback('−5', `cat:p:${product.id}:${Math.max(1, qty - 5)}`),
      Markup.button.callback('−1', `cat:p:${product.id}:${Math.max(1, qty - 1)}`),
      Markup.button.callback(`${qty} шт`, 'noop'),
      Markup.button.callback('+1', `cat:p:${product.id}:${qty + 1}`),
      Markup.button.callback('+5', `cat:p:${product.id}:${qty + 5}`),
    ]);
    rows.push([Markup.button.callback(`✅ Купить за ${money.format(total)}`, `cat:buy:${product.id}:${qty}`)]);
  }
  rows.push([Markup.button.callback('⬅️ В каталог', 'cat:list')]);

  return { text, keyboard: Markup.inlineKeyboard(rows), product, qty };
}

const ERRORS = {
  PRODUCT_UNAVAILABLE: 'Товар больше недоступен.',
  OUT_OF_STOCK: 'Столько единиц уже нет в наличии — обнови каталог.',
  INSUFFICIENT_FUNDS: 'Недостаточно средств на балансе.',
  BAD_QUANTITY: 'Некорректное количество.',
};

function register(bot) {
  const showCatalog = (ctx) => {
    const view = catalogView();
    return ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard });
  };

  bot.hears(BTN.catalog, showCatalog);
  bot.command('catalog', showCatalog);

  bot.action('noop', (ctx) => ctx.answerCbQuery());

  bot.action('cat:list', async (ctx) => {
    await ctx.answerCbQuery();
    const view = catalogView();
    return ctx.editMessageText(view.text, { parse_mode: 'HTML', ...view.keyboard }).catch(() => showCatalog(ctx));
  });

  bot.action(/^cat:p:(\d+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const view = productView(Number(ctx.match[1]), Number(ctx.match[2]));
    if (!view) return ctx.reply('Товар не найден.');
    return ctx
      .editMessageText(view.text, { parse_mode: 'HTML', ...view.keyboard })
      .catch(() => ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard }));
  });

  bot.action(/^cat:buy:(\d+):(\d+)$/, async (ctx) => {
    const productId = Number(ctx.match[1]);
    const quantity = Number(ctx.match[2]);

    let result;
    try {
      result = shop.purchase(ctx.state.user.id, productId, quantity);
    } catch (err) {
      const message = ERRORS[err.message] || 'Не удалось оформить покупку.';
      await ctx.answerCbQuery(message, { show_alert: true });

      if (err.message === 'INSUFFICIENT_FUNDS') {
        await ctx.reply(
          `${message}\nТекущий баланс: <b>${money.format(ctx.state.user.balance_cents)}</b>`,
          { parse_mode: 'HTML', ...Markup.inlineKeyboard([[Markup.button.callback('💳 Пополнить', 'topup:start')]]) },
        );
      }
      if (err.message === 'OUT_OF_STOCK') {
        const view = productView(productId, 1);
        if (view) await ctx.editMessageText(view.text, { parse_mode: 'HTML', ...view.keyboard }).catch(() => {});
      }
      return undefined;
    }

    await ctx.answerCbQuery('Готово!');

    const links = result.payloads.map((p) => `<code>${escapeHtml(p)}</code>`).join('\n');
    await ctx.reply(
      [
        `✅ <b>Покупка оформлена</b> · заказ #${result.orderId}`,
        `${escapeHtml(result.product.title)} · ${result.quantity} шт · ${money.format(result.totalCents)}`,
        '',
        links,
        '',
        'Ссылки всегда доступны в разделе «📦 Мои покупки».',
      ].join('\n'),
      { parse_mode: 'HTML', link_preview_options: { is_disabled: true } },
    );

    const view = productView(productId, 1);
    if (view) await ctx.editMessageText(view.text, { parse_mode: 'HTML', ...view.keyboard }).catch(() => {});

    const buyer = ctx.state.user;
    await notifyAdmins(
      ctx.telegram,
      [
        `🛒 <b>Продажа</b> #${result.orderId}`,
        `Товар: ${escapeHtml(result.product.title)} · ${result.quantity} шт`,
        `Сумма: ${money.format(result.totalCents)}`,
        `Покупатель: <code>${buyer.telegram_id}</code>${buyer.username ? ` (@${buyer.username})` : ''}`,
        `Остаток: ${productsRepo.stock(productId)} шт`,
      ].join('\n'),
    );
    return undefined;
  });
}

module.exports = { register, catalogView, productView };
