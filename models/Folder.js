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
  parentFolderId: {
    type: DataTypes.INTEGER,
    allowNull: true,
    references: {
      model: 'folders',
      key: 'id',
    },
    comment: 'Parent folder for nested structure',
  },
}, {
  tableName: 'folders',
  timestamps: true,
  indexes: [
    { fields: ['userId'] },
    { fields: ['parentFolderId'] },
    { fields: ['userId', 'userPlanId', 'parentFolderId'] },
  ],
});

// Define associations
Folder.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Folder.belongsTo(Folder, { foreignKey: 'parentFolderId', as: 'parentFolder' });
Folder.hasMany(Folder, { foreignKey: 'parentFolderId', as: 'subfolders' });

module.exports = Folder;
