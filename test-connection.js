// Quick MySQL connection test
require('dotenv').config();
const mysql = require('mysql2/promise');

async function testConnection() {
  console.log('Testing MySQL connection...\n');
  console.log('Configuration:');
  console.log('  Host:', process.env.DB_HOST || '145.79.209.227');
  console.log('  Port:', process.env.DB_PORT || 3306);
  console.log('  Database:', process.env.DB_NAME || 'u214419219_matkafun');
  console.log('  User:', process.env.DB_USER || 'u214419219_matkafun');
  console.log('  Password:', process.env.DB_PASSWORD ? '***' : 'Not set');
  console.log('');

  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || '145.79.209.227',
      port: process.env.DB_PORT || 3306,
      user: process.env.DB_USER || 'u214419219_matkafun',
      password: process.env.DB_PASSWORD || 'Marrytube@123!',
      database: process.env.DB_NAME || 'u214419219_matkafun',
    });

    console.log('✅ Connection successful!');
    
    // Test a simple query
    const [rows] = await connection.execute('SELECT 1 as test');
    console.log('✅ Query test successful:', rows);
    
    await connection.end();
    process.exit(0);
  } catch (error) {
    console.error('❌ Connection failed!');
    console.error('Error:', error.message);
    
    if (error.code === 'ER_ACCESS_DENIED_ERROR') {
      console.error('\nPossible issues:');
      console.error('1. Wrong password');
      console.error('2. User does not have permission');
      console.error('3. Database name is incorrect');
      console.error('\nYour access hosts show:');
      console.error('  - % (allows all IPs)');
      console.error('  - 157.48.90.169 (your IP)');
      console.error('  - 162.241.27.216');
      console.error('\nSince % is present, IP is not the issue.');
      console.error('Please verify:');
      console.error('  - Password is correct');
      console.error('  - Database name exists');
      console.error('  - User has proper permissions');
    }
    
    process.exit(1);
  }
}

testConnection();

