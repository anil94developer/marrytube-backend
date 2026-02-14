// Safe script to add 'category' column to storage_plans if missing
// Run: node scripts/add_storageplan_column.js

require('dotenv').config();
const { sequelize, connectDB } = require('../config/database');

async function ensureColumn() {
  try {
    await connectDB();

    const [[exists]] = await sequelize.query(
      "SELECT COUNT(*) as cnt FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'storage_plans' AND column_name = 'category'",
      { type: sequelize.QueryTypes.SELECT }
    );

    const count = exists && (exists.cnt || exists.CNT || exists.count) ? (exists.cnt || exists.CNT || exists.count) : exists.cnt;
    if (parseInt(count, 10) === 0) {
      console.log('Adding column category to storage_plans...');
      await sequelize.query("ALTER TABLE `storage_plans` ADD COLUMN `category` ENUM('per_gb','fixed') NOT NULL DEFAULT 'fixed' AFTER `storage`");
      console.log('Added category column');
    } else {
      console.log('Column category already exists, skipping');
    }

    console.log('Done.');
    process.exit(0);
  } catch (err) {
    console.error('Error ensuring category column:', err);
    process.exit(1);
  }
}

ensureColumn();
