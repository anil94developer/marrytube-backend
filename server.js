const express = require('express');
const path = require('path');
const cors = require('cors');
const dotenv = require('dotenv');
const { connectDB, getDbStatus } = require('./config/database');

// Load environment variables
dotenv.config();

const app = express();

// Serve uploaded media files (local disk)
app.use('/upload', express.static(path.join(__dirname, 'upload')));

// Allowed origins
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:3002',
  'http://127.0.0.1:3000',
  'http://127.0.0.1:3001',
  'http://127.0.0.1:3002',
];

// Use cors package as the single CORS middleware (placed early)
app.use(cors({
  origin: function (origin, callback) {
    // Allow requests with no origin (like mobile apps or curl requests)
    if (!origin) return callback(null, true);

    // Allow localhost/127.0.0.1 origins in development
    if (origin.includes('localhost') || origin.includes('127.0.0.1')) {
      return callback(null, true);
    }

    // Allow explicitly listed origins (kept for production control)
    if (allowedOrigins.indexOf(origin) !== -1) {
      return callback(null, true);
    }

    // Default: deny unknown origins in production, but allow in development
    // For now, allow to avoid blocking during local development
    return callback(null, true);
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  preflightContinue: false,
  optionsSuccessStatus: 204,
}));

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Routes
const { getBackblazeStatus } = require('./services/s3Service');
const authRoutes = require('./routes/auth');
const mediaRoutes = require('./routes/media');
const storageRoutes = require('./routes/storage');
const adminRoutes = require('./routes/admin');
const studioRoutes = require('./routes/studio');
const shareRoutes = require('./routes/share');

app.use('/api/auth', authRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/storage', storageRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/studio', studioRoutes);
app.use('/api/share', shareRoutes);

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'Server is running', db: getDbStatus() });
});

// Start server
const PORT = process.env.PORT || 5000;

// Try DB connection, but don't block server startup.
connectDB().then((ok) => {
  if (!ok) console.warn('⚠️  Starting server without DB connection (will retry on restart).');
}).catch((err) => {
  console.warn('⚠️  DB connection failed at startup:', err?.message || err);
});

const server = app.listen(PORT, () => {
  console.log(`✅ Server is running on port ${PORT}`);
  console.log(`📍 API Health Check: http://localhost:${PORT}/api/health`);
  const b2 = getBackblazeStatus();
  if (b2.configured) {
    console.log(`📦 Backblaze B2: configured (endpoint=${b2.endpoint}, bucket=${b2.bucket}, keyId=${b2.keyIdPrefix})`);
  } else {
    console.log('📦 Backblaze B2: not configured —', b2.hint || 'check .env');
  }
});
// Prevent chunk upload / merge from being killed by default timeout (10 min)
server.timeout = 10 * 60 * 1000;
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Handle port already in use error
server.on('error', (error) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use!`);
    console.error('Solution:');
    console.error(`1. Kill the process: lsof -ti:${PORT} | xargs kill -9`);
    console.error(`2. Or use a different port: PORT=5001 node server.js`);
    process.exit(1);
  } else {
    throw error;
  }
});

module.exports = app;

