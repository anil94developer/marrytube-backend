// MySQL Database Configuration
// Copy these values to your .env file
// 
// IMPORTANT: Username should NOT include @host part
// The host restriction is handled by MySQL server, not in the username

module.exports = {
  // MySQL Database Configuration
  DB_NAME: 'a1770cc9_marrytube',
  DB_USER: 'a1770cc9_marrytube',  // Username only - NO @host part
  DB_PASSWORD: 'Marry@123!',
  DB_HOST: '162.241.27.225',      // MySQL server host
  DB_PORT: 3306,
  
  // Note: MySQL user host restriction (like @localhost or @%) 
  // is configured in cPanel/phpMyAdmin, not here in the username
  
  // Alternative port if default doesn't work:
  // DB_PORT: 3307
  // Or check with your hosting provider for the correct MySQL port
};

