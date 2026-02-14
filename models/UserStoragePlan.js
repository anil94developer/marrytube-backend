const { DataTypes } = require('sequelize');

module.exports = (sequelize) => {
  const UserStoragePlan = sequelize.define('UserStoragePlan', {
    id: {
      type: DataTypes.INTEGER,
      autoIncrement: true,
      primaryKey: true,
    },
    userId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    planId: {
      type: DataTypes.INTEGER,
      allowNull: false,
    },
    totalStorage: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    usedStorage: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    availableStorage: {
      type: DataTypes.FLOAT,
      allowNull: false,
      defaultValue: 0,
    },
    expiryDate: {
      type: DataTypes.DATE,
      allowNull: false,
    },
    status: {
      type: DataTypes.STRING,
      allowNull: false,
      defaultValue: 'active', // 'active', 'expired'
    },
  }, {
    tableName: 'user_storage_plans',
    timestamps: true,
  });

  return UserStoragePlan;
};
