const TelegramBot = require('node-telegram-bot-api');
const {
  addTransaction,
  getBalance,
  getAllBalances,
  getProjectStats,
  getRecentTransactions,
  deleteTransaction,
} = require('./database');

// Названия проектов — можно изменить в .env (через запятую)
const PROJECTS = (process.env.PROJECTS || 'Проект 1,Проект 2,Проект 3,Проект 4')
  .split(',')
  .map(p => p.trim());

// Состояние пользователей в памяти: chatId -> { step, type, project, description }
const userStates = new Map();

// ─── Форматирование суммы ────────────────────────────────────────────────────
function fmt(amount) {
  const abs = Math.abs(amount);
  const formatted = new Intl.NumberFormat('ru-RU').format(abs);
  return `${formatted} ₽`;
}

function fmtSigned(amount) {
  const sign = amount >= 0 ? '+' : '−';
  return `${sign}${fmt(amount)}`;
}

// ─── Клавиатуры ─────────────────────────────────────────────────────────────
const MAIN_KEYBOARD = {
  inline_keyboard: [
    [
      { text: '📈 Приход', callback_data: 'type:income' },
      { text: '📉 Расход', callback_data: 'type:expense' },
    ],
    [
      { text: '💰 Балансы', callback_data: 'balances' },
      { text: '📋 История', callback_data: 'history' },
    ],
  ],
};

function projectsKeyboard(prefix) {
  return {
    inline_keyboard: [
      ...PROJECTS.map((p, i) => [{ text: p, callback_data: `${prefix}:${i}` }]),
      [{ text: '◀️ Главное меню', callback_data: 'main' }],
    ],
  };
}

function backToMainBtn() {
  return { inline_keyboard: [[{ text: '◀️ Главное меню', callback_data: 'main' }]] };
}

// ─── Вспомогательные ────────────────────────────────────────────────────────
async function editOrSend(bot, chatId, msgId, text, keyboard, opts = {}) {
  try {
    await bot.editMessageText(text, {
      chat_id: chatId,
      message_id: msgId,
      reply_markup: keyboard,
      parse_mode: 'HTML',
      ...opts,
    });
  } catch {
    await bot.sendMessage(chatId, text, {
      reply_markup: keyboard,
      parse_mode: 'HTML',
      ...opts,
    });
  }
}

// ─── Основная функция создания бота ─────────────────────────────────────────
function createBot(token) {
  const bot = new TelegramBot(token, { polling: true });

  // /start
  bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    userStates.delete(chatId);
    await bot.sendMessage(
      chatId,
      '👋 <b>Учёт доходов и расходов</b>\n\nВыберите действие:',
      { parse_mode: 'HTML', reply_markup: MAIN_KEYBOARD }
    );
  });

  // /balance — быстрая команда
  bot.onText(/\/balance/, async (msg) => {
    const chatId = msg.chat.id;
    await bot.sendMessage(chatId, buildBalancesText(), {
      parse_mode: 'HTML',
      reply_markup: backToMainBtn(),
    });
  });

  // Callback-кнопки
  bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const msgId = query.message.message_id;
    const data = query.data;

    await bot.answerCallbackQuery(query.id).catch(() => {});

    // Главное меню
    if (data === 'main') {
      userStates.delete(chatId);
      await editOrSend(bot, chatId, msgId, '👋 <b>Главное меню</b>\n\nВыберите действие:', MAIN_KEYBOARD);
      return;
    }

    // Выбор типа: приход / расход
    if (data.startsWith('type:')) {
      const type = data.split(':')[1]; // 'income' | 'expense'
      userStates.set(chatId, { type, step: 'choose_project' });
      const label = type === 'income' ? '📈 Приход' : '📉 Расход';
      await editOrSend(
        bot, chatId, msgId,
        `${label}\n\nВыберите проект:`,
        projectsKeyboard('proj')
      );
      return;
    }

    // Выбор проекта
    if (data.startsWith('proj:')) {
      const state = userStates.get(chatId);
      if (!state) return;
      const idx = parseInt(data.split(':')[1], 10);
      state.project = PROJECTS[idx];
      state.step = 'enter_description';
      userStates.set(chatId, state);
      const label = state.type === 'income' ? '📈 Приход' : '📉 Расход';
      await editOrSend(
        bot, chatId, msgId,
        `${label} · <b>${state.project}</b>\n\n✏️ Введите <b>назначение</b> (описание):`,
        { inline_keyboard: [[{ text: '◀️ Назад', callback_data: `type:${state.type}` }]] }
      );
      return;
    }

    // Показать все балансы
    if (data === 'balances') {
      await editOrSend(bot, chatId, msgId, buildBalancesText(), backToMainBtn());
      return;
    }

    // История — выбор проекта
    if (data === 'history') {
      await editOrSend(
        bot, chatId, msgId,
        '📋 <b>История</b>\n\nВыберите проект:',
        projectsKeyboard('hist')
      );
      return;
    }

    // История конкретного проекта
    if (data.startsWith('hist:')) {
      const idx = parseInt(data.split(':')[1], 10);
      const project = PROJECTS[idx];
      const text = buildHistoryText(project);
      const keyboard = {
        inline_keyboard: [
          [{ text: '◀️ К списку проектов', callback_data: 'history' }],
          [{ text: '◀️ Главное меню', callback_data: 'main' }],
        ],
      };
      await editOrSend(bot, chatId, msgId, text, keyboard);
      return;
    }

    // Подтверждение удаления последней транзакции
    if (data.startsWith('del:')) {
      const txId = parseInt(data.split(':')[1], 10);
      deleteTransaction(txId);
      await editOrSend(
        bot, chatId, msgId,
        '🗑 <b>Запись удалена.</b>',
        MAIN_KEYBOARD
      );
      return;
    }
  });

  // Текстовые сообщения — ввод описания и суммы
  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    if (!msg.text || msg.text.startsWith('/')) return;

    const state = userStates.get(chatId);
    if (!state) return;

    // Шаг 3: ввод описания
    if (state.step === 'enter_description') {
      state.description = msg.text.trim();
      state.step = 'enter_amount';
      userStates.set(chatId, state);
      const label = state.type === 'income' ? '📈 Приход' : '📉 Расход';
      await bot.sendMessage(
        chatId,
        `${label} · <b>${state.project}</b>\nНазначение: ${state.description}\n\n💵 Введите <b>сумму</b>:`,
        {
          parse_mode: 'HTML',
          reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'main' }]] },
        }
      );
      return;
    }

    // Шаг 4: ввод суммы
    if (state.step === 'enter_amount') {
      // Принимаем числа вида: 100 000, 100.000, 100,5 и т.д.
      const raw = msg.text.replace(/\s/g, '').replace(',', '.');
      const amount = parseFloat(raw);
      if (isNaN(amount) || amount <= 0) {
        await bot.sendMessage(chatId, '❌ Введите корректную сумму — положительное число:', {
          reply_markup: { inline_keyboard: [[{ text: '❌ Отмена', callback_data: 'main' }]] },
        });
        return;
      }

      const result = addTransaction(state.type, state.project, state.description, amount);
      const balance = getBalance(state.project);
      const label = state.type === 'income' ? '📈 Приход' : '📉 Расход';
      const sign = state.type === 'income' ? '+' : '−';
      const balEmoji = balance >= 0 ? '✅' : '⚠️';

      const keyboard = {
        inline_keyboard: [
          [{ text: '🗑 Отменить запись', callback_data: `del:${result.lastInsertRowid}` }],
          [{ text: '◀️ Главное меню', callback_data: 'main' }],
        ],
      };

      await bot.sendMessage(
        chatId,
        `✅ <b>Сохранено!</b>\n\n` +
        `${label}: <b>${sign}${fmt(amount)}</b>\n` +
        `Проект: ${state.project}\n` +
        `Назначение: ${state.description}\n\n` +
        `${balEmoji} Баланс <b>${state.project}</b>: <b>${fmtSigned(balance)}</b>`,
        { parse_mode: 'HTML', reply_markup: keyboard }
      );

      userStates.delete(chatId);
      return;
    }
  });

  bot.on('polling_error', (err) => console.error('[Bot] polling error:', err.message));

  return bot;
}

// ─── Формирование текстов ────────────────────────────────────────────────────
function buildBalancesText() {
  const balances = getAllBalances(PROJECTS);
  let text = '💰 <b>Балансы по проектам</b>\n\n';
  let total = 0;
  for (const { project, balance } of balances) {
    const emoji = balance >= 0 ? '✅' : '⚠️';
    text += `${emoji} <b>${project}</b>\n`;
    text += `   Баланс: <b>${fmtSigned(balance)}</b>\n`;
    const stats = getProjectStats(project);
    text += `   📈 ${fmt(stats.total_income)}  📉 ${fmt(stats.total_expense)}\n\n`;
    total += balance;
  }
  const totalEmoji = total >= 0 ? '✅' : '⚠️';
  text += `${totalEmoji} <b>Итого по всем проектам: ${fmtSigned(total)}</b>`;
  return text;
}

function buildHistoryText(project) {
  const txs = getRecentTransactions(project, 15);
  const balance = getBalance(project);
  let text = `📋 <b>История: ${project}</b>\n`;
  text += `💰 Баланс: <b>${fmtSigned(balance)}</b>\n\n`;

  if (txs.length === 0) {
    text += '<i>Нет транзакций</i>';
  } else {
    for (const t of txs) {
      const emoji = t.type === 'income' ? '📈' : '📉';
      const sign = t.type === 'income' ? '+' : '−';
      const date = t.created_at.slice(0, 10);
      text += `${emoji} <b>${sign}${fmt(t.amount)}</b>  ${t.description}  <i>${date}</i>\n`;
    }
    text += `\n<i>Показаны последние ${txs.length} записей</i>`;
  }
  return text;
}

module.exports = { createBot };
