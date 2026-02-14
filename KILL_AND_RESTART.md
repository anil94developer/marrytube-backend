# Kill Port 5001 and Restart Server

## Problem
Port 5001 is already in use, preventing server from starting.

## Solution

### Method 1: Manual Kill and Restart

**Step 1: Kill all processes on port 5001**
```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
lsof -ti:5001 | xargs kill -9
```

**Step 2: Wait 2-3 seconds**
```bash
sleep 3
```

**Step 3: Verify port is free**
```bash
lsof -ti:5001
```
(Should return nothing if port is free)

**Step 4: Start server**
```bash
node server.js
```

---

### Method 2: Use the Restart Script

```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
./restart-server.sh
```

---

### Method 3: Kill All Node Processes (Nuclear Option)

If port keeps getting occupied:

```bash
# Kill all node processes
pkill -9 node

# Wait a moment
sleep 2

# Start server
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
node server.js
```

---

### Method 4: Use Different Port

If port 5001 keeps having issues:

```bash
PORT=5001 node server.js
```

Then update frontend `.env`:
```env
REACT_APP_API_URL=http://localhost:5001/api
```

---

## Quick One-Liner

```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend" && lsof -ti:5001 | xargs kill -9 2>/dev/null; sleep 2; node server.js
```

---

## Troubleshooting

### If port keeps getting occupied:
1. Check if you have multiple terminals running the server
2. Check if nodemon or another process manager is auto-restarting
3. Use `ps aux | grep node` to see all node processes
4. Kill specific process: `kill -9 <PID>`

### If server won't start:
1. Check MySQL connection is working
2. Check .env file exists and has correct values
3. Check for syntax errors: `node -c server.js`

