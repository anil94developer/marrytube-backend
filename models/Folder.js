const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const User = require('./User');

const Folder = sequelize.define('Folder', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: {
      model: User,
      key: 'id',
    },
  },
  name: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  userPlanId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'References UserStoragePlan.id',
  },
}, {
  tableName: 'folders',
  timestamps: true,
  indexes: [
    { fields: ['userId'] },
  ],
});

// Define associations
Folder.belongsTo(User, { foreignKey: 'userId', as: 'user' });

module.exports = Folder;
