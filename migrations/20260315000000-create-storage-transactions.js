module.exports = {
  up: async (queryInterface, Sequelize) => {
    await queryInterface.createTable('storage_transactions', {
      id: {
        type: Sequelize.INTEGER,
        autoIncrement: true,
        primaryKey: true,
      },
      userId: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      orderId: {
        type: Sequelize.STRING(128),
        allowNull: false,
        unique: true,
      },
      amount: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
      },
      currency: {
        type: Sequelize.STRING(8),
        allowNull: false,
        defaultValue: 'INR',
      },
      storage: {
        type: Sequelize.DECIMAL(10, 2),
        allowNull: false,
      },
      period: {
        type: Sequelize.STRING(16),
        allowNull: false,
        defaultValue: 'month',
      },
      planId: {
        type: Sequelize.INTEGER,
        allowNull: true,
      },
      status: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'pending',
      },
      paymentGateway: {
        type: Sequelize.STRING(32),
        allowNull: false,
        defaultValue: 'cashfree',
      },
      description: {
        type: Sequelize.STRING(255),
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
    await queryInterface.addIndex('storage_transactions', ['userId']);
    await queryInterface.addIndex('storage_transactions', ['orderId'], { unique: true });
    await queryInterface.addIndex('storage_transactions', ['status']);
    await queryInterface.addIndex('storage_transactions', ['createdAt']);
  },
  down: async (queryInterface) => {
    await queryInterface.dropTable('storage_transactions');
  },
};
