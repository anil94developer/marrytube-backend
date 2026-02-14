// Check if admin user exists
require('dotenv').config();
const { User } = require('./models');
const { connectDB } = require('./config/database');

async function checkAdmin() {
  try {
    await connectDB();
    
    const admin = await User.findOne({
      where: { email: 'admin@marrytube.com', userType: 'admin' },
      attributes: { include: ['password'] },
    });
    
    if (admin) {
      console.log('✅ Admin user found!');
      console.log('ID:', admin.id);
      console.log('Email:', admin.email);
      console.log('Name:', admin.name);
      console.log('User Type:', admin.userType);
      console.log('Has Password:', !!admin.password);
      console.log('Is Active:', admin.isActive);
    } else {
      console.log('❌ Admin user not found!');
      console.log('Run: node create-admin.js');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

checkAdmin();

