const config = require('./config');
const { createBot } = require('./bot');
const { createServer } = require('./server');

async function main() {
  const bot = createBot();
  const app = createServer(bot);

  if (config.useWebhook) {
    if (!config.publicUrl) throw new Error('BOT_MODE=webhook требует PUBLIC_URL');
    app.use(
      await bot.createWebhook({
        domain: config.publicUrl,
        path: '/webhook/telegram',
        secret_token: config.webhookSecret || undefined,
      }),
    );
  }

  const server = app.listen(config.port, config.bindHost, () => {
    console.log(`[http] слушаю ${config.bindHost}:${config.port}`);
    if (config.cryptoBot.enabled && config.publicUrl) {
      console.log(`[http] вебхук CryptoBot: ${config.publicUrl}/webhook/cryptobot`);
    }
  });

  if (!config.useWebhook) {
    bot.launch({ dropPendingUpdates: true });
    console.log('[bot] запущен в режиме long polling');
  } else {
    console.log(`[bot] запущен в режиме webhook: ${config.publicUrl}/webhook/telegram`);
  }

  const shutdown = (signal) => {
    console.log(`[app] остановка по ${signal}`);
    bot.stop(signal);
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error('[app] не удалось запустить:', err);
  process.exit(1);
});
