# CORS Error Fix

## Problem
```
Access to XMLHttpRequest at 'http://localhost:5001/api/auth/send-otp' from origin 'http://localhost:3001' 
has been blocked by CORS policy: Response to preflight request doesn't pass access control check: 
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

## Solution Applied

I've updated the CORS configuration in `server.js` to:
1. Explicitly allow localhost origins (3000, 3001)
2. Handle preflight OPTIONS requests
3. Allow necessary headers and methods

## Steps to Fix

### 1. Restart Backend Server

**Stop the current server:**
- Press `Ctrl + C` in the terminal where server is running
- Or kill the process:
  ```bash
  lsof -ti:5001 | xargs kill -9
  ```

**Start the server again:**
```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
node server.js
```

### 2. Verify CORS is Working

After restarting, you should see:
```
✅ Server is running on port 5001
📍 API Health Check: http://localhost:5001/api/health
```

### 3. Test in Browser

1. Open browser console (F12)
2. Try login again
3. CORS error should be gone

## What Changed

**Before:**
```javascript
app.use(cors());
```

**After:**
```javascript
const corsOptions = {
  origin: ['http://localhost:3000', 'http://localhost:3001', ...],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
};

app.use(cors(corsOptions));
app.options('*', cors(corsOptions)); // Handle preflight
```

## If Still Not Working

1. **Check server is running:**
   ```bash
   curl http://localhost:5001/api/health
   ```

2. **Check CORS headers:**
   ```bash
   curl -H "Origin: http://localhost:3001" \
        -H "Access-Control-Request-Method: POST" \
        -H "Access-Control-Request-Headers: Content-Type" \
        -X OPTIONS \
        http://localhost:5001/api/auth/send-otp \
        -v
   ```

3. **Clear browser cache** and try again

4. **Check browser console** for any other errors

## Production Note

For production, update `corsOptions.origin` to only allow your actual frontend domain:
```javascript
origin: ['https://yourdomain.com', 'https://www.yourdomain.com']
```

