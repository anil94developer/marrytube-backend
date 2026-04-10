const { StoragePlan, UserStoragePlan, User } = require('../models');
const { getCommissionPerGB } = require('./commissionService');

/** Expiry = purchase date + period. Handles month-end (e.g. Jan 31 + 1 month = Feb 28). */
function addPeriodToDate(purchaseDate, period) {
  const d = new Date(purchaseDate);
  const day = d.getDate();
  d.setDate(1);
  if (period === 'month') {
    d.setMonth(d.getMonth() + 1);
  } else if (period === 'year') {
    d.setFullYear(d.getFullYear() + 1);
  }
  const lastDay = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
  d.setDate(Math.min(day, lastDay));
  return d;
}

/**
 * Apply a storage plan to a client user (end-customer) and credit the studio wallet.
 * Same behavior as POST /studio/clients/:clientId/purchase-plan.
 */
function toBoolRenew(v) {
  return v === true || v === 'true' || v === 1 || v === '1';
}

async function fulfillPurchasePlanForClient({ clientUserId, planId, requestedStorage, period, isRenew = false, studioId }) {
  const renew = toBoolRenew(isRenew);
  const plan = await StoragePlan.findByPk(parseInt(planId, 10));
  if (!plan) {
    const err = new Error('Plan not found');
    err.statusCode = 404;
    throw err;
  }

  let storageToAdd = 0;
  if (plan.category === 'fixed') {
    storageToAdd = parseFloat(plan.storage);
  } else if (plan.category === 'per_gb') {
    if (requestedStorage == null || Number.isNaN(parseFloat(requestedStorage))) {
      const err = new Error('Storage amount required for per_gb plans');
      err.statusCode = 400;
      throw err;
    }
    storageToAdd = parseFloat(requestedStorage);
  }

  const purchaseDate = new Date();
  const periodType = period === 'year' ? 'year' : 'month';

  let userPlan = null;
  if (renew) {
    userPlan = await UserStoragePlan.findOne({
      where: { userId: clientUserId, planId: plan.id },
      order: [['expiryDate', 'DESC'], ['id', 'DESC']],
    });
  }

  let expiryDate;
  if (userPlan) {
    // Renew: only extend expiry — same GB as before (new GB only on new purchase row).
    const baseDate = userPlan.expiryDate > purchaseDate ? new Date(userPlan.expiryDate) : purchaseDate;
    expiryDate = addPeriodToDate(baseDate, periodType);
    userPlan.expiryDate = expiryDate;
    if (userPlan.status !== 'active') userPlan.status = 'active';
    await userPlan.save();
  } else if (!renew) {
    expiryDate = addPeriodToDate(purchaseDate, periodType);
    userPlan = await UserStoragePlan.create({
      userId: clientUserId,
      planId: plan.id,
      totalStorage: storageToAdd,
      usedStorage: 0,
      availableStorage: storageToAdd,
      expiryDate,
      status: 'active',
    });
  } else {
    const err = new Error('No existing plan found to renew');
    err.statusCode = 400;
    throw err;
  }

  const commissionPerGB = await getCommissionPerGB();
  const walletCredit = storageToAdd * commissionPerGB;
  if (walletCredit > 0) {
    const studio = await User.findByPk(studioId);
    if (studio) {
      const currentWallet = parseFloat(studio.walletBalance) || 0;
      studio.walletBalance = currentWallet + walletCredit;
      await studio.save();
    }
  }

  return { plan, userPlan, added: storageToAdd };
}

module.exports = { fulfillPurchasePlanForClient, addPeriodToDate };
