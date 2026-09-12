const { BTN, mainMenu } = require('../keyboards');
const money = require('../../utils/money');

const GREETING = (user) =>
  [
    `👋 Привет, ${user.first_name || 'друг'}!`,
    '',
    'Это магазин ссылок. Как всё работает:',
    '1️⃣ Пополняешь баланс (пока — криптовалютой).',
    '2️⃣ Выбираешь товар в каталоге и указываешь количество.',
    '3️⃣ Бот сразу выдаёт ссылки и списывает деньги с баланса.',
    '',
    `Твой баланс: <b>${money.format(user.balance_cents)}</b>`,
  ].join('\n');

const HELP = [
  '<b>Помощь</b>',
  '',
  `${BTN.catalog} — список товаров, цена за единицу и остаток на складе.`,
  `${BTN.topup} — пополнение баланса.`,
  `${BTN.profile} — баланс и статистика, история операций.`,
  `${BTN.orders} — все покупки и выданные ссылки.`,
  '',
  'Оплата зачисляется автоматически. Если деньги не пришли в течение 10 минут — напиши в поддержку.',
].join('\n');

function register(bot) {
  bot.start(async (ctx) => {
    await ctx.reply(GREETING(ctx.state.user), {
      parse_mode: 'HTML',
      ...mainMenu(ctx.from.id),
    });
  });

  bot.hears(BTN.help, (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));
  bot.command('help', (ctx) => ctx.reply(HELP, { parse_mode: 'HTML' }));

  bot.command('menu', (ctx) => ctx.reply('Главное меню', mainMenu(ctx.from.id)));
}

module.exports = { register, HELP };
