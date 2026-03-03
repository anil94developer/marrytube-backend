// MySQL Database Configuration
// Copy these values to your .env file
// 
// IMPORTANT: Username should NOT include @host part
// The host restriction is handled by MySQL server, not in the username

module.exports = {
  // MySQL Database Configuration
  DB_NAME: 'u214419219_matkafun',
  DB_USER: 'u214419219_matkafun',  // Username only - NO @host part
  DB_PASSWORD: 'Marrytube@123!',
  DB_HOST: '145.79.209.227',      // MySQL server host
  DB_PORT: 3306,
  
  // Note: MySQL user host restriction (like @localhost or @%) 
  // is configured in cPanel/phpMyAdmin, not here in the username
  
  // Alternative port if default doesn't work:
  // DB_PORT: 3307
  // Or check with your hosting provider for the correct MySQL port
};

