// Simple CORS test server
const express = require('express');
const cors = require('cors');
const app = express();

// Simple CORS - allow all
app.use(cors({
  origin: '*',
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
}));

app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'CORS test server running' });
});

app.post('/api/auth/send-otp', (req, res) => {
  res.json({ success: true, message: 'OTP sent (test)' });
});

app.options('*', (req, res) => {
  res.status(204).end();
});

const PORT = 5001;
app.listen(PORT, () => {
  console.log(`✅ CORS Test Server running on port ${PORT}`);
  console.log(`📍 Test: http://localhost:${PORT}/api/health`);
});

