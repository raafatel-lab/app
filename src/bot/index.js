const { Telegraf, session } = require('telegraf');
const config = require('../config');
const usersRepo = require('../db/users');
const prompts = require('./prompts');
const { BTN } = require('./keyboards');

const start = require('./handlers/start');
const profile = require('./handlers/profile');
const catalog = require('./handlers/catalog');
const topup = require('./handlers/topup');
const admin = require('./handlers/admin');

const MENU_TEXTS = Object.values(BTN);

function createBot() {
  if (!config.botToken) throw new Error('BOT_TOKEN не задан — заполни .env');

  const bot = new Telegraf(config.botToken);

  bot.use(session({ defaultSession: () => ({}) }));

  // Профиль пользователя доступен всем хендлерам как ctx.state.user.
  bot.use(async (ctx, next) => {
    if (!ctx.from || ctx.from.is_bot) return undefined;

    const user = usersRepo.upsertFromTelegram(ctx.from);
    if (user.is_blocked) {
      if (ctx.callbackQuery) return ctx.answerCbQuery('Доступ ограничен.');
      return ctx.reply('🚫 Доступ к магазину ограничен. Напиши в поддержку.');
    }

    ctx.state.user = user;
    return next();
  });

  // Нажатие кнопки главного меню всегда прерывает незаконченный ввод.
  bot.use(async (ctx, next) => {
    const text = ctx.message && ctx.message.text;
    if (text && MENU_TEXTS.includes(text)) prompts.clear(ctx);
    return next();
  });

  start.register(bot);
  profile.register(bot);
  catalog.register(bot);
  topup.register(bot);
  admin.register(bot);

  // Последним — ввод текста для активного шага (сумма пополнения, ссылки и т.д.).
  bot.on('text', async (ctx) => {
    const handled = await prompts.dispatch(ctx);
    if (!handled && !ctx.message.text.startsWith('/')) {
      await ctx.reply('Не понял команду. Выбери действие в меню ниже 👇');
    }
  });

  bot.catch((err, ctx) => {
    console.error(`[bot] ошибка в обработчике ${ctx.updateType}:`, err);
  });

  return bot;
}

module.exports = { createBot };
