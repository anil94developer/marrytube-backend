const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');

const OTP = sequelize.define('OTP', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  identifier: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  type: {
    type: DataTypes.ENUM('email', 'mobile'),
    allowNull: false,
  },
  otp: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: false,
  },
  verified: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
}, {
  tableName: 'otps',
  indexes: [
    { fields: ['identifier', 'type'] },
    { fields: ['expiresAt'] },
  ],
});

module.exports = OTP;
