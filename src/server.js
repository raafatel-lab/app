const express = require('express');
const config = require('./config');
const paymentsRepo = require('./db/payments');
const billing = require('./services/billing');
const usersRepo = require('./db/users');
const cryptobot = require('./payments/cryptobot');
const money = require('./utils/money');
const { notifyUser } = require('./bot/notify');

function createServer(bot) {
  const app = express();

  app.get('/', (req, res) => {
    res.json({ status: 'ok', service: 'telegram-shop-bot', timestamp: new Date().toISOString() });
  });

  app.get('/health', (req, res) => res.json({ status: 'ok' }));

  // Вебхук CryptoBot: моментальное зачисление, без ожидания кнопки «Я оплатил».
  app.post(
    '/webhook/cryptobot',
    express.json({ verify: (req, res, buf) => { req.rawBody = buf.toString('utf8'); } }),
    async (req, res) => {
      const signature = req.get('crypto-pay-api-signature');
      if (!cryptobot.verifyWebhook(req.rawBody || '', signature)) {
        return res.status(401).json({ ok: false });
      }

      // Отвечаем сразу: CryptoBot не должен ждать нашей обработки.
      res.json({ ok: true });

      try {
        const update = req.body || {};
        if (update.update_type !== 'invoice_paid') return undefined;

        const invoice = update.payload || {};
        const payment =
          paymentsRepo.getById(Number(invoice.payload)) ||
          paymentsRepo.getByExternalId('cryptobot', invoice.invoice_id);

        if (!payment || payment.provider !== 'cryptobot') {
          console.warn('[webhook] счёт не найден:', invoice.invoice_id);
          return undefined;
        }

        const result = billing.creditPayment(payment.id);
        if (!result.credited) return undefined;

        const user = usersRepo.getById(payment.user_id);
        if (user && bot) {
          await notifyUser(
            bot.telegram,
            user.telegram_id,
            `✅ Баланс пополнен на ${money.format(payment.amount_cents)}.\nТекущий баланс: <b>${money.format(user.balance_cents)}</b>`,
          );
        }
      } catch (err) {
        console.error('[webhook] ошибка обработки:', err);
      }
      return undefined;
    },
  );

  app.use(express.json());

  return app;
}

module.exports = { createServer, port: config.port };
