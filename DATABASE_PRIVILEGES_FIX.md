# Database Privileges Fix - Step by Step

## Problem Identified

Your database `a1774c4c_marrytube` shows:
- **Privileged Users:** `a1770cc9_shree` ❌

But you need:
- **Privileged Users:** `a1774c4c_marrytube` ✅

The user `a1774c4c_marrytube` doesn't have privileges on the database `a1774c4c_marrytube`.

---

## Solution: Add User to Database in cPanel

### Step-by-Step Instructions:

1. **Go to cPanel → MySQL Databases**
   - Login to cPanel
   - Click on **"MySQL Databases"** icon

2. **Scroll to "Add User To Database" Section**
   - Find the section titled **"Add User To Database"**
   - You'll see two dropdown menus:
     - **User:** (dropdown)
     - **Database:** (dropdown)

3. **Select User and Database**
   - **User dropdown:** Select `a1774c4c_marrytube`
   - **Database dropdown:** Select `a1774c4c_marrytube`
   - Click **"Add"** button

4. **Grant ALL PRIVILEGES**
   - After clicking "Add", you'll see a page with checkboxes
   - Check **"ALL PRIVILEGES"** (or select all privileges)
   - Click **"Make Changes"** or **"Update"**

5. **Verify**
   - Go back to **"Current Databases"** section
   - Check that `a1774c4c_marrytube` database now shows:
     - **Privileged Users:** `a1774c4c_marrytube` ✅

---

## Alternative: Using phpMyAdmin (If Available)

### Method 1: Via SQL

1. **Open phpMyAdmin**
   - In cPanel, click **"phpMyAdmin"**

2. **Run SQL Command**
   ```sql
   -- Grant all privileges to user on database
   GRANT ALL PRIVILEGES ON a1774c4c_marrytube.* TO 'a1774c4c_marrytube'@'%';
   FLUSH PRIVILEGES;
   ```

3. **Verify**
   ```sql
   -- Check privileges
   SHOW GRANTS FOR 'a1774c4c_marrytube'@'%';
   ```

### Method 2: Via phpMyAdmin Interface

1. **Select Database**
   - Click on database `a1774c4c_marrytube` in left sidebar

2. **Go to Privileges Tab**
   - Click on **"Privileges"** tab at the top

3. **Add User**
   - Click **"Add user account"** or **"Edit privileges"**
   - Select user: `a1774c4c_marrytube`
   - Check **"ALL PRIVILEGES"**
   - Click **"Go"**

---

## Complete Checklist

After fixing, verify:

- [ ] User `a1774c4c_marrytube` exists
- [ ] User host is `%` (not `localhost`)
- [ ] User has privileges on database `a1774c4c_marrytube`
- [ ] Database shows `a1774c4c_marrytube` in privileged users list

---

## Test Connection

After making changes:

```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
node test-connection.js
```

Or start server:
```bash
node server.js
```

Expected output:
```
✅ MySQL connected successfully
Server is running on port 5001
```

---

## Common Issues

### Issue 1: User doesn't exist
**Solution:** Create the user first in "MySQL Users" section

### Issue 2: User host is localhost
**Solution:** Change user host from `localhost` to `%` (see CPANEL_MYSQL_FIX.md)

### Issue 3: Privileges not granted
**Solution:** Make sure you clicked "Make Changes" after selecting privileges

---

## Quick SQL Fix (If you have direct MySQL access)

```sql
-- Create user if doesn't exist (with % host)
CREATE USER IF NOT EXISTS 'a1774c4c_marrytube'@'%' IDENTIFIED BY 'Marrytube@123!';

-- Grant all privileges
GRANT ALL PRIVILEGES ON a1774c4c_marrytube.* TO 'a1774c4c_marrytube'@'%';

-- Flush privileges
FLUSH PRIVILEGES;

-- Verify
SHOW GRANTS FOR 'a1774c4c_marrytube'@'%';
```

---

## Summary

**Current Status:**
- Database: `a1774c4c_marrytube` ✅
- Privileged User: `a1770cc9_shree` ❌

**Required Status:**
- Database: `a1774c4c_marrytube` ✅
- Privileged User: `a1774c4c_marrytube` ✅

**Action Needed:**
Add user `a1774c4c_marrytube` to database `a1774c4c_marrytube` with ALL PRIVILEGES.

