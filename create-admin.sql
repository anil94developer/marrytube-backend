-- SQL Query to Insert Admin User
-- Password: admin123 (will be hashed by bcrypt)

-- Option 1: Insert with plain password (Sequelize will hash it automatically)
-- But since we're using raw SQL, we need to hash the password first
-- Use the Node.js script instead (create-admin.js)

-- Option 2: Direct SQL (if you want to set password hash manually)
-- First, generate password hash using Node.js:
-- node -e "const bcrypt = require('bcryptjs'); bcrypt.hash('admin123', 10).then(hash => console.log(hash));"

-- Then use this query (replace HASHED_PASSWORD with the hash from above):
INSERT INTO users (
  email, 
  name, 
  userType, 
  password, 
  permissions, 
  isActive, 
  createdAt, 
  updatedAt
) VALUES (
  'admin@marrytube.com',
  'Admin User',
  'admin',
  'HASHED_PASSWORD_HERE',  -- Replace with bcrypt hash
  '["view_users", "manage_media", "manage_storage", "manage_plans"]',
  1,
  NOW(),
  NOW()
);

-- Option 3: Check if admin exists first
INSERT INTO users (
  email, 
  name, 
  userType, 
  password, 
  permissions, 
  isActive, 
  createdAt, 
  updatedAt
) 
SELECT 
  'admin@marrytube.com',
  'Admin User',
  'admin',
  '$2a$10$rOzJqJqJqJqJqJqJqJqJqOqJqJqJqJqJqJqJqJqJqJqJqJqJqJqJqJq',  -- This is a placeholder, use create-admin.js
  '["view_users", "manage_media", "manage_storage", "manage_plans"]',
  1,
  NOW(),
  NOW()
WHERE NOT EXISTS (
  SELECT 1 FROM users WHERE email = 'admin@marrytube.com' AND userType = 'admin'
);

