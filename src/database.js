const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'expenses.db'));

db.exec(`
  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL CHECK(type IN ('income', 'expense')),
    project TEXT NOT NULL,
    description TEXT NOT NULL,
    amount REAL NOT NULL CHECK(amount > 0),
    created_at DATETIME DEFAULT (datetime('now', 'localtime'))
  );
`);

function addTransaction(type, project, description, amount) {
  return db.prepare(`
    INSERT INTO transactions (type, project, description, amount)
    VALUES (?, ?, ?, ?)
  `).run(type, project, description, amount);
}

function getBalance(project) {
  const row = db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0) -
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS balance
    FROM transactions
    WHERE project = ?
  `).get(project);
  return row.balance;
}

function getAllBalances(projects) {
  return projects.map(project => ({ project, balance: getBalance(project) }));
}

function getProjectStats(project) {
  return db.prepare(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'income'  THEN amount ELSE 0 END), 0) AS total_income,
      COALESCE(SUM(CASE WHEN type = 'expense' THEN amount ELSE 0 END), 0) AS total_expense,
      COUNT(*) AS tx_count
    FROM transactions
    WHERE project = ?
  `).get(project);
}

function getRecentTransactions(project, limit = 10) {
  return db.prepare(`
    SELECT * FROM transactions
    WHERE project = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(project, limit);
}

function deleteTransaction(id) {
  return db.prepare('DELETE FROM transactions WHERE id = ?').run(id);
}

module.exports = {
  addTransaction,
  getBalance,
  getAllBalances,
  getProjectStats,
  getRecentTransactions,
  deleteTransaction,
};
