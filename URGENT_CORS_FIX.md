# 🚨 URGENT: CORS Fix - Kill Old Processes

## Problem
CORS errors are happening because **old backend processes are still running** with old CORS configuration.

## Solution: Kill All Processes and Restart

### Step 1: Kill ALL processes on port 5001

**Run this command:**
```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
lsof -ti:5001 | xargs kill -9
```

**Or use the script:**
```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
./kill-and-restart.sh
```

### Step 2: Verify no processes are running

```bash
lsof -ti:5001
```

**Should return nothing** (no output = good)

### Step 3: Start fresh server

```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
node server.js
```

**You should see:**
```
✅ Server is running on port 5001
📍 API Health Check: http://localhost:5001/api/health
```

### Step 4: Test CORS

1. **Open browser:** `http://localhost:5001/api/health`
   - Should show: `{"status":"OK","message":"Server is running"}`

2. **Test from frontend:**
   - Open: `http://localhost:3001/login`
   - Try to send OTP
   - Check browser console - CORS error should be gone

## Quick One-Liner Fix

```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend" && lsof -ti:5001 | xargs kill -9 && sleep 2 && node server.js
```

## Why This Happens

- Multiple backend processes were started
- Old processes have old CORS configuration
- Browser is connecting to old process
- Need to kill all and start fresh

## Verification

After restarting, check:
1. ✅ Only ONE process on port 5001: `lsof -ti:5001` (should show only one PID)
2. ✅ Backend responds: `curl http://localhost:5001/api/health`
3. ✅ No CORS errors in browser console
4. ✅ OTP send works from frontend

## If Still Not Working

1. **Check backend logs** - Look for CORS-related errors
2. **Check browser Network tab** - See actual request/response headers
3. **Try incognito window** - Rule out browser cache
4. **Check frontend URL** - Make sure it's `http://localhost:3001`

