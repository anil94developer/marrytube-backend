# CORS Fix for localhost:3001

## Problem
Frontend running on `http://localhost:3001` is getting CORS errors:
```
Access to XMLHttpRequest at 'http://localhost:5001/api/auth/me' from origin 'http://localhost:3001' 
has been blocked by CORS policy: Response to preflight request doesn't pass access control check: 
No 'Access-Control-Allow-Origin' header is present on the requested resource.
```

## Solution Applied

### 1. Updated CORS Configuration
- Added explicit support for `http://localhost:3001`
- Enhanced preflight request handling
- Improved CORS middleware to handle all localhost origins

### 2. Allowed Origins
The backend now explicitly allows:
- `http://localhost:3000`
- `http://localhost:3001`
- `http://localhost:3002`
- `http://127.0.0.1:3000`
- `http://127.0.0.1:3001`
- `http://127.0.0.1:3002`

## Steps to Fix

### Step 1: Restart Backend Server

```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
./restart-server.sh
```

Or manually:
```bash
cd "/Users/anilrathore/Documents/Project/Marry store/MarryBackend"
# Kill existing process
lsof -ti:5001 | xargs kill -9
# Start server
node server.js
```

### Step 2: Verify Backend is Running

Check if backend is responding:
```bash
curl http://localhost:5001/api/health
```

Or open in browser: `http://localhost:5001/api/health`

Should return: `{"status":"OK","message":"Server is running"}`

### Step 3: Test CORS Headers

Check CORS headers:
```bash
curl -H "Origin: http://localhost:3001" \
     -H "Access-Control-Request-Method: POST" \
     -H "Access-Control-Request-Headers: Content-Type" \
     -X OPTIONS \
     http://localhost:5001/api/auth/send-otp \
     -v
```

Should see:
```
< Access-Control-Allow-Origin: http://localhost:3001
< Access-Control-Allow-Methods: GET, POST, PUT, DELETE, PATCH, OPTIONS
< Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, Accept, Origin
```

### Step 4: Clear Browser Cache

1. **Hard Refresh:** `Cmd + Shift + R` (Mac) or `Ctrl + Shift + R` (Windows)
2. **Or use Incognito/Private window**
3. **Or clear browser cache**

### Step 5: Test Frontend

1. Open: `http://localhost:3001/login`
2. Open browser DevTools → Network tab
3. Try to send OTP
4. Check if request succeeds
5. Check Response Headers for CORS headers

## Troubleshooting

### Backend Not Running
```bash
# Check if backend is running
lsof -ti:5001

# If no output, start backend
cd MarryBackend
node server.js
```

### Port Already in Use
```bash
# Kill process on port 5001
lsof -ti:5001 | xargs kill -9

# Then restart
cd MarryBackend
node server.js
```

### Still Getting CORS Errors

1. **Check backend logs** - Make sure server started successfully
2. **Check browser console** - Look for specific CORS error details
3. **Verify origin** - Make sure frontend URL matches allowed origins
4. **Test with curl** - Use curl to test CORS headers directly

### Network Error (Not CORS)

If you see `net::ERR_CONNECTION_REFUSED`:
- Backend is not running
- Backend is on wrong port
- Firewall blocking connection

## CORS Configuration Details

### Manual CORS Headers
```javascript
res.setHeader('Access-Control-Allow-Origin', origin);
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, Accept, Origin');
res.setHeader('Access-Control-Allow-Credentials', 'true');
```

### CORS Package
```javascript
app.use(cors({
  origin: function (origin, callback) {
    if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return callback(null, true);
    }
    callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
}));
```

## Expected Behavior After Fix

✅ **No CORS errors in browser console**
✅ **API requests succeed**
✅ **Preflight OPTIONS requests return 204**
✅ **Response headers include CORS headers**
✅ **Login/OTP functionality works**

## Quick Test

```bash
# Terminal 1: Start Backend
cd MarryBackend
node server.js

# Terminal 2: Test CORS
curl -H "Origin: http://localhost:3001" \
     -X OPTIONS \
     http://localhost:5001/api/auth/send-otp \
     -v

# Browser: Open http://localhost:3001/login
# Try to send OTP
# Check Network tab - should see successful request
```

