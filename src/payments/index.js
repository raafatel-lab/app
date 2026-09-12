const config = require('../config');
const paymentsRepo = require('../db/payments');
const billing = require('../services/billing');
const cryptobot = require('./cryptobot');

// Список способов оплаты. Карта и СБП — заглушки: добавим провайдера
// (эквайринг) и включим флагом, остальной код менять не придётся.
function listMethods() {
  return [
    {
      id: 'cryptobot',
      title: '💎 Криптовалюта (CryptoBot)',
      available: config.cryptoBot.enabled,
      note: 'Оплата USDT / TON / BTC и др. через @CryptoBot',
    },
    {
      id: 'manual',
      title: '🪙 Криптоперевод на кошелёк',
      available: config.manualCrypto.enabled && config.manualCrypto.wallets.length > 0,
      note: 'Перевод на наш кошелёк, зачисление после подтверждения оператором',
    },
    { id: 'card', title: '💳 Банковская карта', available: false, note: 'Скоро', disabledNote: 'скоро' },
    { id: 'sbp', title: '🏦 СБП', available: false, note: 'Скоро', disabledNote: 'скоро' },
  ];
}

function getMethod(id) {
  return listMethods().find((m) => m.id === id) || null;
}

async function createTopup({ user, amountCents, method }) {
  const descriptor = getMethod(method);
  if (!descriptor || !descriptor.available) throw new Error('METHOD_UNAVAILABLE');

  const paymentId = paymentsRepo.create({
    userId: user.id,
    provider: method,
    amountCents,
    meta: { telegram_id: user.telegram_id },
  });

  if (method === 'cryptobot') {
    try {
      const invoice = await cryptobot.createInvoice({ amountCents, paymentId });
      paymentsRepo.setExternalId(paymentId, invoice.externalId, invoice.payUrl);
    } catch (err) {
      paymentsRepo.setStatus(paymentId, 'canceled');
      throw err;
    }
  }

  return paymentsRepo.getById(paymentId);
}

// Проверка статуса по кнопке «Я оплатил» и по вебхуку ведёт в одну точку.
async function checkAndCredit(paymentId) {
  const payment = paymentsRepo.getById(paymentId);
  if (!payment) return { status: 'not_found' };
  if (payment.status === 'paid') return { status: 'paid', payment, credited: false };

  if (payment.provider === 'cryptobot') {
    const invoice = await cryptobot.getInvoice(payment.external_id);
    if (!invoice) return { status: 'pending', payment };
    if (invoice.status === 'paid') {
      const result = billing.creditPayment(payment.id);
      return { status: 'paid', payment: result.payment, credited: result.credited };
    }
    if (invoice.status === 'expired') {
      paymentsRepo.setStatus(payment.id, 'expired');
      return { status: 'expired', payment: paymentsRepo.getById(payment.id) };
    }
    return { status: 'pending', payment };
  }

  // manual — ждём подтверждения администратора
  return { status: 'pending', payment };
}

function approveManual(paymentId, adminId) {
  const payment = paymentsRepo.getById(paymentId);
  if (!payment) throw new Error('PAYMENT_NOT_FOUND');
  if (payment.provider !== 'manual') throw new Error('NOT_MANUAL');
  return billing.creditPayment(payment.id, `Пополнение #${payment.id} подтверждено админом ${adminId}`);
}

function rejectManual(paymentId) {
  const payment = paymentsRepo.getById(paymentId);
  if (!payment || payment.status === 'paid') throw new Error('PAYMENT_NOT_PENDING');
  paymentsRepo.setStatus(paymentId, 'canceled');
  return paymentsRepo.getById(paymentId);
}

module.exports = { listMethods, getMethod, createTopup, checkAndCredit, approveManual, rejectManual, cryptobot };
