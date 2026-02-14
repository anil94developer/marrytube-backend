const { DataTypes } = require('sequelize');
const { sequelize } = require('../config/database');
const User = require('./User');

const StudioClient = sequelize.define('StudioClient', {
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
  email: {
    type: DataTypes.STRING,
    allowNull: true,
    set(value) {
      if (value) {
        this.setDataValue('email', value.toLowerCase().trim());
      } else {
        this.setDataValue('email', null);
      }
    },
  },
  mobile: {
    type: DataTypes.STRING,
    allowNull: true,
    set(value) {
      if (value) {
        this.setDataValue('mobile', value.trim());
      } else {
        this.setDataValue('mobile', null);
      }
    },
  },
}, {
}, {
  tableName: 'studio_clients',
  indexes: [
    { fields: ['studioId'] },
    { fields: ['userId'] },
  ],
});

// Define associations
StudioClient.belongsTo(User, { foreignKey: 'studioId', as: 'studio' });
StudioClient.belongsTo(User, { foreignKey: 'userId', as: 'user' });

module.exports = StudioClient;
