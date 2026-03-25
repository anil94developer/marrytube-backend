-- Run once if studio registration fails with ENUM / Data truncated on userType
-- Backup DB before altering production.

ALTER TABLE users
MODIFY COLUMN userType ENUM('customer', 'admin', 'studio')
NOT NULL
DEFAULT 'customer';
