# 🚨 STEP-BY-STEP CORS FIX

## Problem
CORS errors because **2 processes are running on port 5001** with old configuration.

## Solution: Kill ALL and Restart

### Step 1: Kill ALL processes on port 5001

**Run this command:**
```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
lsof -ti:5001 | xargs kill -9
```

**Or use the script:**
```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
./FINAL_CORS_FIX.sh
```

### Step 2: Wait 3 seconds
```bash
sleep 3
```

### Step 3: Verify NO processes are running
```bash
lsof -ti:5001
```
**Should return NOTHING** (empty = good)

### Step 4: Start fresh server
```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
node server.js
```

**Expected output:**
```
✅ Server is running on port 5001
📍 API Health Check: http://localhost:5001/api/health
```

### Step 5: Test in browser

1. **Open:** `http://localhost:5001/api/health`
   - Should show: `{"status":"OK","message":"Server is running"}`

2. **Open:** `http://localhost:3001/login`
   - Try to send OTP
   - Check browser console
   - CORS error should be GONE

## Quick One-Liner

```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend" && lsof -ti:5001 | xargs kill -9 && sleep 3 && node server.js
```

## Why This Works

- **2 processes** were running on port 5001
- Old processes had **old CORS config**
- Browser was connecting to **old process**
- Killing all and restarting loads **new CORS config**

## Verification Checklist

After restarting, verify:

- [ ] Only ONE process: `lsof -ti:5001` (should show 1 PID)
- [ ] Backend responds: `curl http://localhost:5001/api/health`
- [ ] No CORS errors in browser console
- [ ] OTP send works from frontend

## If Still Not Working

1. **Check backend terminal** - Look for errors
2. **Check browser Network tab** - See actual request headers
3. **Try incognito window** - Rule out cache
4. **Check frontend URL** - Must be `http://localhost:3001`

