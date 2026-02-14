// Safe script to add city, address, pincode columns to users table if missing
// Run: node scripts/add_user_columns.js

require('dotenv').config();
const { sequelize, connectDB } = require('../config/database');

async function ensureColumns() {
  try {
    await connectDB();

    const dbNameResult = await sequelize.query("SELECT DATABASE() as db", { type: sequelize.QueryTypes.SELECT });
    // Check columns existence using information_schema
    const columnsToAdd = [
      { name: 'city', sql: "ADD COLUMN `city` VARCHAR(255) NULL AFTER `alternatePhone`" },
      { name: 'address', sql: "ADD COLUMN `address` TEXT NULL AFTER `city`" },
      { name: 'pincode', sql: "ADD COLUMN `pincode` VARCHAR(50) NULL AFTER `address`" },
    ];

    for (const col of columnsToAdd) {
      const [[exists]] = await sequelize.query(
        `SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'users' AND column_name = '${col.name}'`,
        { type: sequelize.QueryTypes.SELECT }
      );

      const count = exists && (exists.cnt || exists.CNT || exists.count) ? (exists.cnt || exists.CNT || exists.count) : exists.cnt;
      if (parseInt(count, 10) === 0) {
        console.log(`Adding column ${col.name}...`);
        await sequelize.query(`ALTER TABLE \`users\` ${col.sql}`);
        console.log(`Added ${col.name}`);
      } else {
        console.log(`Column ${col.name} already exists, skipping`);
      }
    }

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Error ensuring columns:', err);
    process.exit(1);
  }
}

ensureColumns();
