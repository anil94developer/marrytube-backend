const { sequelize } = require('../config/database');

// Import all models
const User = require('./User');
const Media = require('./Media');
const Folder = require('./Folder');
const Storage = require('./Storage');
const StoragePlan = require('./StoragePlan');
const UserStoragePlan = require('./UserStoragePlan')(sequelize);
const OTP = require('./OTP');
const StudioClient = require('./StudioClient');
const FundRequest = require('./FundRequest');
const AppSetting = require('./AppSetting');

// Define associations
User.hasMany(Media, { foreignKey: 'userId', as: 'media' });
User.hasOne(Storage, { foreignKey: 'userId', as: 'storage' });
User.hasMany(Folder, { foreignKey: 'userId', as: 'folders' });
User.hasMany(StudioClient, { foreignKey: 'studioId', as: 'studioClients' });
User.hasMany(StudioClient, { foreignKey: 'userId', as: 'clients' });
User.hasMany(FundRequest, { foreignKey: 'studioId', as: 'fundRequests' });

Folder.hasMany(Media, { foreignKey: 'folderId', as: 'media' });

module.exports = {
  sequelize,
  User,
  Media,
  Folder,
  Storage,
  StoragePlan,
  OTP,
  StudioClient,
  FundRequest,
  UserStoragePlan,
  AppSetting,
};

