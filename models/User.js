const { DataTypes } = require('sequelize');
const bcrypt = require('bcryptjs');
const { sequelize } = require('../config/database');

const User = sequelize.define('User', {
  id: {
    type: DataTypes.INTEGER,
    primaryKey: true,
    autoIncrement: true,
  },
  email: {
    type: DataTypes.STRING,
    allowNull: true,
    unique: true,
    validate: {
      isEmail: true,
    },
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
    unique: true,
    set(value) {
      if (value) {
        this.setDataValue('mobile', value.trim());
      } else {
        this.setDataValue('mobile', null);
      }
    },
  },
  name: {
    type: DataTypes.STRING,
    defaultValue: 'User',
  },
  alternatePhone: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  city: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  address: {
    type: DataTypes.TEXT,
    allowNull: true,
  },
  pincode: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  userType: {
    type: DataTypes.ENUM('customer', 'admin', 'studio'),
    defaultValue: 'customer',
  },
  password: {
    type: DataTypes.STRING,
    allowNull: true,
  },
  permissions: {
    type: DataTypes.JSON,
    defaultValue: [],
  },
  walletBalance: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  earnings: {
    type: DataTypes.DECIMAL(10, 2),
    defaultValue: 0,
  },
  isActive: {
    type: DataTypes.BOOLEAN,
    defaultValue: true,
  },
}, {
  tableName: 'users',
  hooks: {
    beforeCreate: async (user) => {
      if (user.password) {
        user.password = await bcrypt.hash(user.password, 10);
      }
    },
    beforeUpdate: async (user) => {
      if (user.changed('password') && user.password) {
        user.password = await bcrypt.hash(user.password, 10);
      }
    },
  },
  indexes: [
    { fields: ['email'] },
    { fields: ['mobile'] },
    { fields: ['userType'] },
  ],
});

// Method to compare password
User.prototype.comparePassword = async function(candidatePassword) {
  if (!this.password) return false;
  return await bcrypt.compare(candidatePassword, this.password);
};

// Method to get user data without password
User.prototype.toJSON = function() {
  const values = { ...this.get() };
  delete values.password;
  return values;
};

module.exports = User;
