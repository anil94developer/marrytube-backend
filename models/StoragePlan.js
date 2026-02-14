const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const StoragePlan = sequelize.define('StoragePlan', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  storage: {
    type: DataTypes.DECIMAL(10, 2), // in GB
    allowNull: false,
  },
  category: {
    type: DataTypes.ENUM('per_gb', 'fixed'),
    allowNull: false,
    defaultValue: 'fixed',
  },
  price: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  period: {
    type: DataTypes.ENUM('month', 'year'),
    allowNull: false,
  },
  periodLabel: {
    type: DataTypes.STRING,
    defaultValue: 'per month',
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: 'storage_plans',
});

module.exports = StoragePlan;
