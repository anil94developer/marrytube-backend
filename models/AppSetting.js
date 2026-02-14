const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const AppSetting = sequelize.define('AppSetting', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  key: {
    type: DataTypes.STRING(100),
    allowNull: false,
    unique: true,
  },
  value: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
}, {
  tableName: 'app_settings',
  timestamps: true,
  indexes: [{ unique: true, fields: ['key'] }],
});

module.exports = AppSetting;
