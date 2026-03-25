# Fix: `userType` must allow `studio` (MySQL)

If studio registration returns **500** and the error mentions **Data truncated**, **ENUM**, or **userType**, your `users` table was probably created before `studio` was added to the enum.

### 1. Check current column (MySQL)

```sql
SHOW COLUMNS FROM users LIKE 'userType';
```

### 2. Alter column to include `studio`

Run on your database (adjust if your enum already differs):

```sql
ALTER TABLE users
MODIFY COLUMN userType ENUM('customer', 'admin', 'studio')
NOT NULL
DEFAULT 'customer';
```

### 3. Retry

`POST /api/studio/register` should return **200** after this.

---

**Note:** The Sequelize model defines `userType` as `ENUM('customer', 'admin', 'studio')`. If `sequelize.sync({ alter: false })` is used (default in this project), MySQL is **not** updated automatically — you must run the SQL above once on existing databases.
