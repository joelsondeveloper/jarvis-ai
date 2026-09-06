import Database from "better-sqlite3";

const database: Database.Database = new Database("jarvis.db");

database.pragma("journal_mode = WAL");

database.exec(`
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

export { database };