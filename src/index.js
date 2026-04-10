require('dotenv').config();
const express = require('express');
const { createBot } = require('./bot');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Expense tracker bot is running', timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// Start Telegram bot
const token = process.env.TELEGRAM_BOT_TOKEN;
if (!token) {
  console.error('ERROR: TELEGRAM_BOT_TOKEN is not set in environment variables.');
  process.exit(1);
}

const bot = createBot(token);
console.log('Telegram bot started.');
