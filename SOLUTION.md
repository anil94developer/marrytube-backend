# Solution for Connection Issues

## Issue 1: Missing Dependencies (sequelize module not found)

### Solution:
Run this command in the MarryBackend directory:

```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
npm install
```

If you get permission errors, try:
```bash
sudo npm install
```

Or fix npm permissions first:
```bash
sudo chown -R $(whoami) ~/.npm
npm install
```

---

## Issue 2: MySQL Access Denied Error

**Error:** `Access denied for user 'a1770cc9_marrytube'@'157.48.90.169'`

### Problem:
The MySQL user is restricted to a specific host (usually `localhost`). Even if access hosts are whitelisted, the user itself needs to allow connections from your IP.

### Root Cause:
MySQL users have a host restriction. Common patterns:
- ❌ `a1770cc9_marrytube@localhost` - Only allows localhost connections
- ✅ `a1770cc9_marrytube@%` - Allows all hosts
- ✅ `a1770cc9_marrytube@157.48.90.169` - Allows specific IP

### Solution: Update MySQL User Host in cPanel

#### Step-by-Step Instructions:

1. **Login to cPanel**
   - Go to your hosting control panel
   - Login with your credentials

2. **Navigate to MySQL Databases**
   - Find **"MySQL Databases"** or **"MySQL Database Wizard"**
   - Click on it

3. **Find Your MySQL User**
   - Scroll down to **"Current Users"** section
   - Look for user: `a1770cc9_marrytube`
   - Check the host column (it might show `localhost`)

4. **Update User Host**
   - Click on the user or find **"Change Password"** / **"Modify User"** option
   - Look for **"Access Hosts"** or **"Host"** field
   - Change from `localhost` to `%` (allows all IPs)
   - OR add your specific IP: `157.48.90.169`

5. **Alternative: Create New User with Correct Host**
   - If you can't modify, create a new user:
     - Username: `a1770cc9_marrytube` (or same)
     - Host: `%` (or your IP `157.48.90.169`)
     - Password: `Shree@123!`
   - Grant privileges to database `a1770cc9_marrytube`

6. **Grant Database Privileges**
   - Make sure the user has **ALL PRIVILEGES** on database `a1770cc9_marrytube`
   - In cPanel, you can do this in **"Add User To Database"** section

7. **Save Changes**
   - Click **"Make Changes"** or **"Update"**
   - Wait a few seconds for changes to propagate

#### Quick Fix via SQL (if you have phpMyAdmin access):

```sql
-- Option 1: Update existing user host
RENAME USER 'a1770cc9_marrytube'@'localhost' TO 'a1770cc9_marrytube'@'%';

-- Option 2: Create new user with % host
CREATE USER 'a1770cc9_marrytube'@'%' IDENTIFIED BY 'Shree@123!';
GRANT ALL PRIVILEGES ON a1770cc9_marrytube.* TO 'a1770cc9_marrytube'@'%';
FLUSH PRIVILEGES;
```

#### Verify the Fix:

After making changes, test the connection:
```bash
node test-connection.js
```

Or start the server:
```bash
node server.js
```

You should see: `✅ MySQL connected successfully`

---

## Complete Setup Steps:

1. **Install Dependencies:**
   ```bash
   cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
   npm install
   ```

2. **Create .env file** (if not exists):
   ```bash
   # Create .env file
   cat > .env << 'EOF'
   PORT=5001
   NODE_ENV=development
   DB_NAME=a1770cc9_marrytube
   DB_USER=a1770cc9_marrytube
   DB_PASSWORD=Shree@123!
   DB_HOST=162.241.27.225
   DB_PORT=3306
   JWT_SECRET=marrytube-secret-key-change-in-production-2024
   EOF
   ```

3. **Whitelist Your IP** in hosting control panel

4. **Test Connection:**
   ```bash
   node server.js
   ```

---

## Troubleshooting:

### If npm install fails:
- Check Node.js version: `node --version` (should be v14+)
- Clear npm cache: `npm cache clean --force`
- Try: `npm install --legacy-peer-deps`

### If MySQL connection still fails:
- Verify credentials in hosting control panel
- Check if MySQL service is running
- Verify database name exists
- Check firewall settings
- Contact hosting support to whitelist your IP

### If you get "Table doesn't exist" error:
The tables will be created automatically on first run. If not, you can manually create them or set:
```javascript
await sequelize.sync({ alter: true }); // In config/database.js
```

---

## Quick Test:

After fixing the issues, test the connection:
```bash
node -e "require('./config/database.js').connectDB().then(() => console.log('Success!')).catch(e => console.error('Error:', e.message))"
```

