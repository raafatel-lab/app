const { Markup } = require('telegraf');
const config = require('../../config');
const { BTN } = require('../keyboards');
const money = require('../../utils/money');
const paymentsService = require('../../payments');
const paymentsRepo = require('../../db/payments');
const prompts = require('../prompts');
const { notifyAdmins } = require('../notify');
const { escapeHtml } = require('./profile');

const QUICK_AMOUNTS = [500, 1000, 2000, 5000];

function methodsView() {
  const methods = paymentsService.listMethods();
  const available = methods.filter((m) => m.available);

  const rows = methods.map((m) => [
    Markup.button.callback(
      m.available ? m.title : `${m.title} — ${m.disabledNote || 'недоступно'}`,
      m.available ? `topup:m:${m.id}` : 'topup:soon',
    ),
  ]);

  if (!available.length) {
    return {
      text: '💳 Пополнение временно недоступно. Напиши в поддержку — включим оплату вручную.',
      keyboard: Markup.inlineKeyboard(rows),
    };
  }

  const text = [
    '💳 <b>Пополнение баланса</b>',
    '',
    'Выбери способ оплаты:',
    '',
    ...available.map((m) => `• ${m.title} — ${m.note}`),
    '',
    `Минимальная сумма: ${money.format(config.minTopupCents)}`,
  ].join('\n');

  return { text, keyboard: Markup.inlineKeyboard(rows) };
}

function amountView(method) {
  const rows = [];
  for (let i = 0; i < QUICK_AMOUNTS.length; i += 2) {
    rows.push(
      QUICK_AMOUNTS.slice(i, i + 2).map((sum) =>
        Markup.button.callback(money.format(sum * 100), `topup:a:${method}:${sum * 100}`),
      ),
    );
  }
  rows.push([Markup.button.callback('⬅️ Назад', 'topup:start')]);

  return {
    text: [
      '💳 <b>Сумма пополнения</b>',
      '',
      'Выбери сумму кнопкой или отправь своё число сообщением.',
      `Диапазон: ${money.format(config.minTopupCents)} — ${money.format(config.maxTopupCents)}`,
    ].join('\n'),
    keyboard: Markup.inlineKeyboard(rows),
  };
}

function invoiceKeyboard(payment) {
  const rows = [];
  if (payment.pay_url) rows.push([Markup.button.url('💎 Перейти к оплате', payment.pay_url)]);
  rows.push([Markup.button.callback('🔄 Я оплатил — проверить', `topup:check:${payment.id}`)]);
  rows.push([Markup.button.callback('❌ Отменить счёт', `topup:cancel:${payment.id}`)]);
  return Markup.inlineKeyboard(rows);
}

async function createAndSend(ctx, method, amountCents) {
  if (amountCents < config.minTopupCents || amountCents > config.maxTopupCents) {
    return ctx.reply(
      `Сумма должна быть от ${money.format(config.minTopupCents)} до ${money.format(config.maxTopupCents)}.`,
    );
  }

  let payment;
  try {
    payment = await paymentsService.createTopup({ user: ctx.state.user, amountCents, method });
  } catch (err) {
    console.error('[topup] создание счёта:', err.message);
    return ctx.reply('Не удалось создать счёт. Попробуй ещё раз или выбери другой способ оплаты.');
  }

  if (method === 'manual') {
    const wallets = config.manualCrypto.wallets
      .map((w) => `• <b>${escapeHtml(w.label)}</b>\n<code>${escapeHtml(w.address)}</code>`)
      .join('\n');

    await notifyAdmins(
      ctx.telegram,
      [
        `🪙 <b>Заявка на пополнение</b> #${payment.id}`,
        `Сумма: ${money.format(payment.amount_cents)}`,
        `Пользователь: <code>${ctx.state.user.telegram_id}</code>${ctx.state.user.username ? ` (@${ctx.state.user.username})` : ''}`,
      ].join('\n'),
      Markup.inlineKeyboard([
        [
          Markup.button.callback('✅ Зачислить', `adm:payok:${payment.id}`),
          Markup.button.callback('❌ Отклонить', `adm:payno:${payment.id}`),
        ],
      ]),
    );

    return ctx.reply(
      [
        `🪙 <b>Счёт #${payment.id}</b> на ${money.format(payment.amount_cents)}`,
        '',
        'Переведи сумму на один из кошельков:',
        wallets,
        '',
        `⚠️ В комментарии к переводу укажи: <code>${payment.id}</code>`,
        'После перевода нажми «Я оплатил» — оператор подтвердит зачисление.',
      ].join('\n'),
      { parse_mode: 'HTML', ...invoiceKeyboard(payment) },
    );
  }

  return ctx.reply(
    [
      `💎 <b>Счёт #${payment.id}</b> на ${money.format(payment.amount_cents)}`,
      '',
      'Оплати по кнопке ниже — счёт можно закрыть любой поддерживаемой криптовалютой.',
      'Баланс пополнится автоматически сразу после оплаты.',
      `Счёт активен ${Math.round(config.cryptoBot.invoiceTtlSeconds / 60)} мин.`,
    ].join('\n'),
    { parse_mode: 'HTML', ...invoiceKeyboard(payment) },
  );
}

function register(bot) {
  const showMethods = (ctx) => {
    prompts.clear(ctx);
    const view = methodsView();
    return ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard });
  };

  bot.hears(BTN.topup, showMethods);
  bot.command('topup', showMethods);

  bot.action('topup:start', async (ctx) => {
    await ctx.answerCbQuery();
    return showMethods(ctx);
  });

  bot.action('topup:soon', (ctx) => ctx.answerCbQuery('Этот способ появится позже 🙂', { show_alert: true }));

  bot.action(/^topup:m:(\w+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const method = ctx.match[1];
    if (!paymentsService.getMethod(method)?.available) return ctx.reply('Способ оплаты недоступен.');

    prompts.ask(ctx, 'topup_amount', { method });
    const view = amountView(method);
    return ctx.reply(view.text, { parse_mode: 'HTML', ...view.keyboard });
  });

  bot.action(/^topup:a:(\w+):(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    prompts.clear(ctx);
    return createAndSend(ctx, ctx.match[1], Number(ctx.match[2]));
  });

  prompts.register('topup_amount', async (ctx, state) => {
    const amount = money.parseAmount(ctx.message.text);
    if (amount === null) return ctx.reply('Нужно число, например: 1500');

    prompts.clear(ctx);
    return createAndSend(ctx, state.method, amount);
  });

  bot.action(/^topup:check:(\d+)$/, async (ctx) => {
    const paymentId = Number(ctx.match[1]);
    const payment = paymentsRepo.getById(paymentId);
    if (!payment || payment.user_id !== ctx.state.user.id) return ctx.answerCbQuery('Счёт не найден.');

    let result;
    try {
      result = await paymentsService.checkAndCredit(paymentId);
    } catch (err) {
      console.error('[topup] проверка счёта:', err.message);
      return ctx.answerCbQuery('Не удалось проверить оплату, попробуй позже.', { show_alert: true });
    }

    if (result.status === 'paid') {
      await ctx.answerCbQuery('Оплата получена!');
      await ctx.editMessageReplyMarkup(undefined).catch(() => {});
      const user = require('../../db/users').getById(ctx.state.user.id);
      return ctx.reply(
        `✅ Баланс пополнен на ${money.format(payment.amount_cents)}.\nТекущий баланс: <b>${money.format(user.balance_cents)}</b>`,
        { parse_mode: 'HTML' },
      );
    }

    if (result.status === 'expired') {
      await ctx.answerCbQuery('Счёт истёк, создай новый.', { show_alert: true });
      return ctx.editMessageReplyMarkup(undefined).catch(() => {});
    }

    return ctx.answerCbQuery(
      payment.provider === 'manual'
        ? 'Заявка у оператора, зачислим после подтверждения.'
        : 'Оплата пока не поступила. Если оплатил — подожди минуту и проверь снова.',
      { show_alert: true },
    );
  });

  bot.action(/^topup:cancel:(\d+)$/, async (ctx) => {
    const paymentId = Number(ctx.match[1]);
    const payment = paymentsRepo.getById(paymentId);
    if (!payment || payment.user_id !== ctx.state.user.id) return ctx.answerCbQuery('Счёт не найден.');
    if (payment.status === 'paid') return ctx.answerCbQuery('Счёт уже оплачен.');

    paymentsRepo.setStatus(paymentId, 'canceled');
    await ctx.answerCbQuery('Счёт отменён.');
    return ctx.editMessageReplyMarkup(undefined).catch(() => {});
  });
}

module.exports = { register };
