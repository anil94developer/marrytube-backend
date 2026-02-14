const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const User = require('./User');
const Folder = require('./Folder');

const Media = sequelize.define('Media', {
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
  url: {
    type: DataTypes.TEXT,
    allowNull: false,
  },
  s3Key: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  category: {
    type: DataTypes.ENUM('image', 'video', 'document', 'other'),
    allowNull: false,
  },
  size: {
    type: DataTypes.BIGINT, // Size in bytes
    allowNull: false,
  },
  mimeType: {
    type: DataTypes.STRING,
    allowNull: false,
  },
  folderId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: Folder,
      key: 'id',
    },
  },
  userPlanId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    comment: 'References UserStoragePlan.id',
  },
  uploadedBy: {
    type: DataTypes.ENUM('user', 'studio'),
    defaultValue: 'user',
  },
  blocked: {
    type: DataTypes.BOOLEAN,
    defaultValue: false,
  },
  uploadDate: {
    type: DataTypes.DATE,
    defaultValue: DataTypes.NOW,
  },
}, {
  tableName: 'media',
  indexes: [
    { fields: ['userId'] },
    { fields: ['folderId'] },
    { fields: ['category'] },
    { fields: ['uploadDate'] },
  ],
});

// Define associations
Media.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Media.belongsTo(Folder, { foreignKey: 'folderId', as: 'folder' });

module.exports = Media;
