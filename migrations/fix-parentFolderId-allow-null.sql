-- Allow parentFolderId to be NULL (for root-level folders)
-- Run this if you get: Column 'parentFolderId' cannot be null

ALTER TABLE folders MODIFY COLUMN parentFolderId INT NULL;
