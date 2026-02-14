const { AppSetting } = require('../models');

const COMMISSION_KEY = 'commission_per_gb';

/**
 * Get commission per 1 GB (₹) from DB. Returns 0 if not set.
 */
async function getCommissionPerGB() {
  try {
    const row = await AppSetting.findOne({ where: { key: COMMISSION_KEY } });
    if (!row || row.value == null || row.value === '') return 0;
    const val = parseFloat(String(row.value));
    return isNaN(val) || val < 0 ? 0 : val;
  } catch (e) {
    console.error('commissionService getCommissionPerGB:', e.message);
    return 0;
  }
}

/**
 * Save commission per 1 GB (₹) in DB.
 */
async function setCommissionPerGB(amount) {
  const val = parseFloat(amount);
  if (isNaN(val) || val < 0) {
    throw new Error('Invalid commission amount');
  }
  const [row] = await AppSetting.findOrCreate({
    where: { key: COMMISSION_KEY },
    defaults: { value: String(val) },
  });
  if (row) {
    row.value = String(val);
    await row.save();
  }
  return val;
}

module.exports = { getCommissionPerGB, setCommissionPerGB };
