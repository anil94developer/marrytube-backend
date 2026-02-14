const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const User = require('./User');

const FundRequest = sequelize.define('FundRequest', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  studioId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: User,
      key: 'id',
    },
  },
  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  status: {
    type: DataTypes.ENUM('pending', 'approved', 'rejected'),
    defaultValue: 'pending',
  },
  remarks: {
    type: DataTypes.TEXT,
    defaultValue: '',
  },
  processedAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'fund_requests',
  indexes: [
    { fields: ['studioId'] },
    { fields: ['status'] },
    { fields: ['createdAt'] },
  ],
});

// Define associations
FundRequest.belongsTo(User, { foreignKey: 'studioId', as: 'studio' });

module.exports = FundRequest;
