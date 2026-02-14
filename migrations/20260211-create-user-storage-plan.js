module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('user_storage_plans', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      planId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      totalStorage: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      usedStorage: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      availableStorage: {
        type: Sequelize.FLOAT,
        allowNull: false,
        defaultValue: 0,
      },
      expiryDate: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      status: {
        type: Sequelize.STRING,
        allowNull: false,
        defaultValue: 'active',
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });
  },
  down: async (queryInterface, Sequelize) => {
    await queryInterface.dropTable('user_storage_plans');
  },
};
