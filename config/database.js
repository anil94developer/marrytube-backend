const { Sequelize } = require('sequelize');
const dotenv = require('dotenv');

dotenv.config();

// MySQL connection configuration
const sequelize = new Sequelize(
  process.env.DB_NAME || 'u214419219_matkafun',
  process.env.DB_USER || 'u214419219_matkafun',
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

// Test connection
const connectDB = async () => {
  try {
    await sequelize.authenticate();
    console.log('MySQL connected successfully');
    
    // Sync models (set to false in production, use migrations instead)
    if (process.env.NODE_ENV === 'development') {
      await sequelize.sync({ alter: false }); // Set to true to auto-update tables
    }
  } catch (error) {
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
        console.error('2. Find user: u214419219_matkafun');
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
    
    process.exit(1);
  }
};

module.exports = { sequelize, connectDB };

