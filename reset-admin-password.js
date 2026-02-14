// Reset admin password
// Run: node reset-admin-password.js

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { User } = require('./models');
const { connectDB } = require('./config/database');

async function resetAdminPassword() {
  try {
    await connectDB();
    
    const adminEmail = 'admin@marrytube.com';
    const newPassword = 'admin123';
    
    const admin = await User.findOne({
      where: { email: adminEmail, userType: 'admin' }
    });
    
    if (!admin) {
      console.log('❌ Admin user not found!');
      console.log('Run: node create-admin.js');
      process.exit(1);
    }
    
    // Hash and update password
    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await admin.update({ password: hashedPassword });
    
    console.log('✅ Admin password reset successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Email:', admin.email);
    console.log('New Password:', newPassword);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error:', error.message);
    process.exit(1);
  }
}

resetAdminPassword();

