//! Database backend abstraction: MySQL (default, web version) or SQLite (native app).
//!
//! Both backends use `?` positional placeholders, so most queries are shared.
//! The differences handled here:
//!   • JSON: MySQL has a native JSON type (sqlx maps to serde_json::Value); SQLite
//!     stores JSON as TEXT, so we serialize on write and parse on read.
//!   • Timestamps: MySQL uses DATETIME (NaiveDateTime); SQLite stores ISO-8601 TEXT.
//!   • Dialect: INSERT IGNORE / ON DUPLICATE KEY (MySQL) vs
//!     INSERT OR IGNORE / ON CONFLICT (SQLite); last_insert_id().

use sqlx::mysql::MySqlPool;
use sqlx::sqlite::SqlitePool;

#[derive(Clone)]
pub enum Db {
    My(MySqlPool),
    Sq(SqlitePool),
}

impl Db {
    pub fn is_sqlite(&self) -> bool {
        matches!(self, Db::Sq(_))
    }
}
