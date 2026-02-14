const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const User = require('./User');

const Storage = sequelize.define('Storage', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    unique: true,
    references: {
      model: User,
      key: 'id',
    },
  },
  totalStorage: {
    type: DataTypes.DECIMAL(10, 2), // in GB
    defaultValue: 1,
  },
  usedStorage: {
    type: DataTypes.DECIMAL(10, 2), // in GB
    defaultValue: 0,
  },
  availableStorage: {
    type: DataTypes.DECIMAL(10, 2), // in GB
    defaultValue: 1,
  },
  lastUpdated: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'storage',
  hooks: {
    beforeSave: (storage) => {
      storage.availableStorage = parseFloat(storage.totalStorage) - parseFloat(storage.usedStorage);
      storage.lastUpdated = new Date();
    },
  },
  indexes: [
    { fields: ['userId'], unique: true },
  ],
});

// Define associations
Storage.belongsTo(User, { foreignKey: 'userId', as: 'user' });

module.exports = Storage;
