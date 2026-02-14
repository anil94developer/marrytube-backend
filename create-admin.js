// Script to create admin user
// Run: node create-admin.js

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { User } = require('./models');
const { sequelize, connectDB } = require('./config/database');

async function createAdmin() {
  try {
    // Connect to database
    await connectDB();
    
    // Admin credentials
    const adminEmail = 'admin@marrytube.com';
    const adminPassword = 'admin123';
    const adminName = 'Admin User';
    
    // Check if admin already exists
    const existingAdmin = await User.findOne({
      where: { email: adminEmail, userType: 'admin' }
    });
    
    if (existingAdmin) {
      console.log('⚠️  Admin user already exists!');
      console.log('Email:', existingAdmin.email);
      console.log('ID:', existingAdmin.id);
      console.log('\n🔄 Resetting password...');
      
      // Update password
      const hashedPassword = await bcrypt.hash(adminPassword, 10);
      await existingAdmin.update({ password: hashedPassword });
      
      console.log('✅ Admin password reset successfully!');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('Email:', existingAdmin.email);
      console.log('New Password:', adminPassword);
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      process.exit(0);
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(adminPassword, 10);
    
    // Create admin user
    const admin = await User.create({
      email: adminEmail,
      name: adminName,
      userType: 'admin',
      password: hashedPassword,
      permissions: ['view_users', 'manage_media', 'manage_storage', 'manage_plans'],
      isActive: true,
    });
    
    console.log('✅ Admin user created successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Email:', admin.email);
    console.log('Password:', adminPassword);
    console.log('User Type:', admin.userType);
    console.log('ID:', admin.id);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\nYou can now login with:');
    console.log('Email: admin@marrytube.com');
    console.log('Password: admin123');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating admin user:', error.message);
    process.exit(1);
  }
}

createAdmin();

