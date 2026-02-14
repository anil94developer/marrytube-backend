'use strict';

module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('folders', 'userPlanId', {
      type: Sequelize.INTEGER,
      allowNull: true,
    });
  },

  down: async (queryInterface, Sequelize) => {
    await queryInterface.changeColumn('folders', 'userPlanId', {
      type: Sequelize.INTEGER,
      allowNull: false,
    });
  },
};
