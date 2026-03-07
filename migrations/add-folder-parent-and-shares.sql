-- Add parent folder and shares table. Run manually if not using sequelize.sync({ alter: true }) once.
-- Sequelize uses camelCase column names by default.

-- 1. Add parentFolderId to folders (skip if already added)
-- ALTER TABLE folders ADD COLUMN parentFolderId INT NULL;
-- CREATE INDEX idx_folders_parent ON folders(parentFolderId);

-- 2. Create shares table (Sequelize will create this on app start if sync runs)
-- CREATE TABLE IF NOT EXISTS shares (
--   id INT AUTO_INCREMENT PRIMARY KEY,
--   token VARCHAR(64) NOT NULL UNIQUE,
--   resourceType ENUM('folder', 'media') NOT NULL,
--   resourceId INT NOT NULL,
--   userId INT NOT NULL,
--   expiresAt DATETIME NULL,
--   createdAt DATETIME NOT NULL,
--   updatedAt DATETIME NOT NULL
-- );

-- Recommended: run the app once with alter: true in config/database.js to add parentFolderId and create shares.
