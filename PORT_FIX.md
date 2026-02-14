# Port 5001 Already in Use - Solution

## Quick Fix

### Method 1: Kill Process on Port 5001 (Recommended)

Run this command in your terminal:

```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
lsof -ti:5001 | xargs kill -9
```

Or use the script:
```bash
./kill-port.sh
```

Then start server:
```bash
node server.js
```

---

### Method 2: Use Different Port

If you want to use a different port (e.g., 5001):

```bash
PORT=5001 node server.js
```

Or update `.env` file:
```env
PORT=5001
```

---

### Method 3: Find and Kill All Node Processes

If multiple Node processes are running:

```bash
# Find all node processes
ps aux | grep node

# Kill all node processes (be careful!)
pkill -9 node

# Then start server
node server.js
```

---

## Permanent Solution

I've updated `server.js` to show a helpful error message if port is in use. The server will now:

1. Show clear error message
2. Suggest solutions
3. Exit gracefully

---

## Check What's Using Port 5001

To see what process is using port 5001:

```bash
lsof -i:5001
```

This will show:
- Process ID (PID)
- Process name
- User running it

---

## Prevention

Always stop the server properly:
- Press `Ctrl + C` in the terminal where server is running
- Or use: `pkill -f "node server.js"`

---

## Quick Commands

```bash
# Kill port 5001
lsof -ti:5001 | xargs kill -9

# Start server
node server.js

# Or use different port
PORT=5001 node server.js
```

