const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const FILE_PATH = path.join(DATA_DIR, 'studio_bank.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function readAll() {
  try {
    ensureDataDir();
    if (fs.existsSync(FILE_PATH)) {
      const raw = fs.readFileSync(FILE_PATH, 'utf8');
      return JSON.parse(raw);
    }
  } catch (e) {
    console.error('studioBankService readAll:', e.message);
  }
  return {};
}

/**
 * Get bank details for a studio.
 * @param {number} studioId
 * @returns {{ accountHolderName?, accountNumber?, ifsc?, bankName?, branch? }}
 */
function getBankDetails(studioId) {
  const all = readAll();
  return all[String(studioId)] || {};
}

/**
 * Save bank details for a studio.
 * @param {number} studioId
 * @param {object} data - { accountHolderName, accountNumber, ifsc, bankName, branch }
 */
function setBankDetails(studioId, data) {
  const all = readAll();
  all[String(studioId)] = {
    accountHolderName: data.accountHolderName || '',
    accountNumber: data.accountNumber || '',
    ifsc: data.ifsc || '',
    bankName: data.bankName || '',
    branch: data.branch || '',
  };
  ensureDataDir();
  fs.writeFileSync(FILE_PATH, JSON.stringify(all, null, 2), 'utf8');
  return all[String(studioId)];
}

module.exports = { getBankDetails, setBankDetails };
