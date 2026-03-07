const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const User = require('./User');

const Share = sequelize.define('Share', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  token: {
    type: DataTypes.STRING(64),
    allowNull: false,
    unique: true,
  },
  resourceType: {
    type: DataTypes.ENUM('folder', 'media', 'drive'),
    allowNull: false,
  },
  resourceId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    comment: 'folder id, media id, or 0 for default drive / plan id for drive',
  },
  userId: {
    type: DataTypes.INTEGER,
    allowNull: false,
    references: { model: User, key: 'id' },
  },
  expiresAt: {
    type: DataTypes.DATE,
    allowNull: true,
  },
}, {
  tableName: 'shares',
  timestamps: true,
  indexes: [
    { unique: true, fields: ['token'] },
    { fields: ['userId'] },
  ],
});

Share.belongsTo(User, { foreignKey: 'userId', as: 'user' });

module.exports = Share;
