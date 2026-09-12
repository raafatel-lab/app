const config = require('../config');

// Внутри всё считается в копейках (целые числа), чтобы не ловить ошибки float.
function format(cents) {
  const value = (Number(cents) / 100).toFixed(2).replace(/\.00$/, '');
  return `${value} ${config.currencySymbol}`;
}

// "150", "150.50", "150,50" -> 15050
function parseAmount(input) {
  const normalized = String(input).trim().replace(',', '.').replace(/\s+/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(normalized)) return null;
  return Math.round(Number(normalized) * 100);
}

function toMajor(cents) {
  return Number((Number(cents) / 100).toFixed(2));
}

module.exports = { format, parseAmount, toMajor };
