require('./loadEnv');

const { Sequelize } = require('sequelize');
const sequelize = new Sequelize(
  process.env.DB_NAME || 'a1774c4c_marrytube',
  process.env.DB_USER || 'a1774c4c_marrytube',
  process.env.DB_PASSWORD || 'Marrytube@123!',
  {
    host: process.env.DB_HOST || '145.79.209.227',
    port: process.env.DB_PORT || 3306,
    dialect: 'mysql',
    logging: process.env.NODE_ENV === 'development' ? console.log : false,
    pool: {
      max: 5,
      min: 0,
      acquire: 30000,
      idle: 10000
    },
    define: {
      timestamps: true,
      underscored: false,
    },
    dialectOptions: {
      connectTimeout: 60000,
    }
  }
);

let dbConnected = false;

// Test connection
const connectDB = async () => {
  try {
    await sequelize.authenticate();
    console.log('MySQL connected successfully');
    dbConnected = true;

    // Create missing tables (e.g. `otps`). Alter only if DB_SYNC_ALTER=true (can be risky on large DBs).
    const syncAlter = String(process.env.DB_SYNC_ALTER || '').toLowerCase() === 'true';
    await sequelize.sync({ alter: syncAlter });
    if (syncAlter) console.log('DB sync: alter mode enabled (DB_SYNC_ALTER=true)');
  } catch (error) {
    dbConnected = false;
    console.error('MySQL connection error:', error.message);
    
    // Provide helpful error messages
    if (error.original) {
      if (error.original.code === 'ER_ACCESS_DENIED_ERROR') {
        console.error('\n❌ Access Denied Error!');
        const connectingIP = error.original.sqlMessage.match(/@'([^']+)'/)?.[1] || 'unknown';
        console.error('Connecting from IP:', connectingIP);
        console.error('\nPossible causes:');
        console.error('1. MySQL user is restricted to @localhost (needs to be @% or @your-ip)');
        console.error('2. Wrong password');
        console.error('3. User does not have privileges on the database');
        console.error('\nSolution:');
        console.error('1. Go to cPanel → MySQL Databases');
        console.error('2. Find user: a1774c4c_marrytube');
        console.error('3. Change host from "localhost" to "%" (allows all IPs)');
        console.error('4. Or create user with host: ' + connectingIP);
        console.error('\nSee CPANEL_MYSQL_FIX.md for detailed steps');
      } else if (error.original.code === 'ECONNREFUSED') {
        console.error('\n❌ Connection Refused!');
        console.error('Cannot connect to MySQL server. Check:');
        console.error('1. MySQL service is running');
        console.error('2. Host and port are correct');
        console.error('3. Firewall allows connections');
      } else if (error.original.code === 'ENOTFOUND') {
        console.error('\n❌ Host Not Found!');
        console.error('Cannot resolve MySQL hostname. Check DB_HOST in .env file');
      }
    }
    
    // Do not crash the whole server on DB errors.
    // Many routes depend on DB and will fail until DB is back,
    // but keeping the server up helps debugging (e.g. S3/Backblaze).
    return false;
  }
  return true;
};

const getDbStatus = () => ({ connected: dbConnected });

module.exports = { sequelize, connectDB, getDbStatus };

