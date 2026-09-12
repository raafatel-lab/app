require('dotenv').config();

function parseAdmins(raw) {
  return String(raw || '')
    .split(/[,\s]+/)
    .map((v) => v.trim())
    .filter(Boolean)
    .map(Number)
    .filter((v) => Number.isInteger(v) && v > 0);
}

const config = {
  botToken: process.env.BOT_TOKEN || '',
  admins: parseAdmins(process.env.ADMIN_IDS),

  // Валюта баланса магазина. Баланс везде хранится в минорных единицах (копейках).
  currency: process.env.CURRENCY || 'RUB',
  currencySymbol: process.env.CURRENCY_SYMBOL || '₽',

  minTopupCents: Number(process.env.MIN_TOPUP || 100) * 100,
  maxTopupCents: Number(process.env.MAX_TOPUP || 100000) * 100,

  dbPath: process.env.DB_PATH || 'data/shop.db',

  port: Number(process.env.PORT || 3000),
  // Публичный адрес сервера — нужен для вебхуков платёжек и (опционально) бота.
  publicUrl: (process.env.PUBLIC_URL || '').replace(/\/+$/, ''),
  useWebhook: process.env.BOT_MODE === 'webhook',
  webhookSecret: process.env.BOT_WEBHOOK_SECRET || '',

  cryptoBot: {
    enabled: Boolean(process.env.CRYPTO_PAY_TOKEN),
    token: process.env.CRYPTO_PAY_TOKEN || '',
    // pay.crypt.bot — боевая сеть, testnet-pay.crypt.bot — тестовая
    apiUrl: process.env.CRYPTO_PAY_API_URL || 'https://pay.crypt.bot/api',
    // Активы, которыми разрешено платить. Пусто — все, что включены в @CryptoBot.
    assets: (process.env.CRYPTO_PAY_ASSETS || '').split(',').map((a) => a.trim()).filter(Boolean),
    invoiceTtlSeconds: Number(process.env.CRYPTO_PAY_TTL || 3600),
  },

  // Ручная оплата криптой: пользователь переводит на кошелёк, админ подтверждает.
  manualCrypto: {
    enabled: process.env.MANUAL_CRYPTO === '1',
    wallets: (process.env.MANUAL_CRYPTO_WALLETS || '')
      .split(';')
      .map((row) => row.trim())
      .filter(Boolean)
      .map((row) => {
        const [label, address] = row.split('=');
        return { label: (label || '').trim(), address: (address || '').trim() };
      })
      .filter((w) => w.label && w.address),
  },
};

config.isAdmin = (telegramId) => config.admins.includes(Number(telegramId));

module.exports = config;
