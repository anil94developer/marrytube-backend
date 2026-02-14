module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('app_settings', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      key: {
        type: Sequelize.STRING(100),
        allowNull: false,
        unique: true,
      },
      value: {
        type: Sequelize.TEXT,
        allowNull: true,
      },
      createdAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
      updatedAt: {
        type: Sequelize.DATE,
        allowNull: false,
      },
    });
    await queryInterface.addIndex('app_settings', ['key'], { unique: true });
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('app_settings');
  },
};
