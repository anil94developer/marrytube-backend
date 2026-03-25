const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const User = require('./User');

const Transaction = sequelize.define('Transaction', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: User, key: 'id' },
  },
  orderId: {
    type: DataTypes.STRING(128),
    allowNull: false,
    unique: true,
  },
  amount: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  currency: {
    type: DataTypes.STRING(8),
    allowNull: false,
    defaultValue: 'INR',
  },
  storage: {
    type: DataTypes.DECIMAL(10, 2),
    allowNull: false,
  },
  period: {
    type: DataTypes.STRING(16),
    allowNull: false,
    defaultValue: 'month',
  },
  planId: {
    type: DataTypes.INTEGER,
    allowNull: true,
  },
  status: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'pending',
  },
  paymentGateway: {
    type: DataTypes.STRING(32),
    allowNull: false,
    defaultValue: 'cashfree',
  },
  description: {
    type: DataTypes.STRING(255),
    allowNull: true,
  },
}, {
  tableName: 'storage_transactions',
  timestamps: true,
  updatedAt: true,
  indexes: [
    { fields: ['userId'] },
    { fields: ['orderId'], unique: true },
    { fields: ['status'] },
    { fields: ['createdAt'] },
  ],
});

Transaction.belongsTo(User, { foreignKey: 'userId', as: 'user' });

module.exports = Transaction;
