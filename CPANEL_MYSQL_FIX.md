# cPanel MySQL User Host Fix - Step by Step

## Problem
MySQL user `u214419219_matkafun` is restricted to `localhost` only, but you're connecting from remote IP `157.48.90.169`.

## Solution: Change MySQL User Host in cPanel

### Method 1: Using cPanel MySQL Databases (Recommended)

1. **Login to cPanel**
   ```
   https://your-domain.com/cpanel
   ```

2. **Go to MySQL Databases**
   - Find **"MySQL Databases"** icon
   - Click on it

3. **Find Current Users Section**
   - Scroll down to **"Current Users"**
   - Look for: `u214419219_matkafun@localhost`

4. **Update User Host**
   - Click on the user or find **"Actions"** dropdown
   - Select **"Change Password"** or **"Modify User"**
   - Look for **"Access Hosts"** field
   - Change from `localhost` to `%`
   - Click **"Update"** or **"Make Changes"**

5. **Verify Database Privileges**
   - Scroll to **"Add User To Database"** section
   - Make sure user `u214419219_matkafun` has access to database `u214419219_matkafun`
   - If not, add the user to the database

### Method 2: Using phpMyAdmin (If Available)

1. **Open phpMyAdmin**
   - In cPanel, find **"phpMyAdmin"**
   - Click to open

2. **Go to User Accounts**
   - Click on **"User accounts"** tab
   - Find user: `u214419219_matkafun`

3. **Edit User**
   - Click **"Edit privileges"** for the user
   - Look for **"Login Information"** section
   - Change **"Host name"** from `localhost` to `%`
   - Click **"Go"**

4. **Grant Database Privileges**
   - Make sure user has privileges on database `u214419219_matkafun`
   - Select database → **"Privileges"** → Check **"ALL PRIVILEGES"**

### Method 3: Create New User (If Can't Modify)

1. **In cPanel → MySQL Databases**

2. **Create New User**
   - Username: `u214419219_matkafun_remote` (or same name)
   - Password: `Marrytube@123!`
   - Host: `%` (or your IP `157.48.90.169`)

3. **Add User to Database**
   - Select user: `u214419219_matkafun_remote`
   - Select database: `u214419219_matkafun`
   - Click **"Add"**
   - Grant **ALL PRIVILEGES**

4. **Update .env file**
   ```env
   DB_USER=u214419219_matkafun_remote
   ```

## SQL Commands (If you have direct MySQL access)

```sql
-- Check current users
SELECT user, host FROM mysql.user WHERE user = 'u214419219_matkafun';

-- Option 1: Rename user host
RENAME USER 'u214419219_matkafun'@'localhost' TO 'u214419219_matkafun'@'%';

-- Option 2: Create new user with % host
CREATE USER 'u214419219_matkafun'@'%' IDENTIFIED BY 'Marrytube@123!';
GRANT ALL PRIVILEGES ON u214419219_matkafun.* TO 'u214419219_matkafun'@'%';
FLUSH PRIVILEGES;

-- Verify
SELECT user, host FROM mysql.user WHERE user = 'u214419219_matkafun';
```

## After Making Changes

1. **Wait 1-2 minutes** for changes to propagate

2. **Test Connection:**
   ```bash
   cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
   node test-connection.js
   ```

3. **Start Server:**
   ```bash
   node server.js
   ```

## Expected Result

You should see:
```
✅ MySQL connected successfully
Server is running on port 5001
```

## Troubleshooting

### If still getting access denied:
1. Check password is correct
2. Verify database name exists
3. Make sure user has privileges on the database
4. Try connecting with specific IP instead of `%`:
   - Create user: `u214419219_matkafun@157.48.90.169`

### Common Issues:
- **User exists but wrong host**: Must change host from `localhost` to `%`
- **Password mismatch**: Reset password in cPanel
- **No database privileges**: Grant privileges in cPanel

