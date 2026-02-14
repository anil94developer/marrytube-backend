// Script to create studio user
// Run: node create-studio.js

require('dotenv').config();
const bcrypt = require('bcryptjs');
const { User } = require('./models');
const { sequelize, connectDB } = require('./config/database');

async function createStudio() {
  try {
    // Connect to database
    await connectDB();
    
    // Studio credentials
    const studioEmail = 'studio@marrytube.com';
    const studioPassword = 'studio123';
    const studioName = 'Studio User';
    
    // Check if studio already exists
    const existingStudio = await User.findOne({
      where: { email: studioEmail, userType: 'studio' }
    });
    
    if (existingStudio) {
      console.log('✅ Studio user already exists!');
      console.log('Email:', existingStudio.email);
      console.log('ID:', existingStudio.id);
      process.exit(0);
    }
    
    // Hash password
    const hashedPassword = await bcrypt.hash(studioPassword, 10);
    
    // Create studio user
    const studio = await User.create({
      email: studioEmail,
      name: studioName,
      userType: 'studio',
      password: hashedPassword,
      walletBalance: 0,
      earnings: 0,
      isActive: true,
    });
    
    console.log('✅ Studio user created successfully!');
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('Email:', studio.email);
    console.log('Password:', studioPassword);
    console.log('User Type:', studio.userType);
    console.log('ID:', studio.id);
    console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
    console.log('\nYou can now login with:');
    console.log('Email: studio@marrytube.com');
    console.log('Password: studio123');
    
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating studio user:', error.message);
    process.exit(1);
  }
}

createStudio();

