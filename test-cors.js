// Quick CORS test script
const express = require('express');
const cors = require('cors');

const app = express();

// Simple CORS - allow all
app.use(cors({
  origin: true,
  credentials: true,
}));

// Manual CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
  res.header('Access-Control-Allow-Credentials', 'true');
  next();
});

app.options('*', (req, res) => {
  res.sendStatus(204);
});

app.post('/api/auth/send-otp', (req, res) => {
  res.json({ success: true, message: 'OTP sent successfully' });
});

app.listen(5001, () => {
  console.log('CORS test server running on port 5001');
});

