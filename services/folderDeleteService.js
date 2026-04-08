const path = require('path');
const fs = require('fs');
const { Op } = require('sequelize');
const { Media, Folder, Storage, UserStoragePlan } = require('../models');
const { deleteFile } = require('./s3Service');

/** Collect all nested folder ids under folderId (does not include folderId itself). */
async function getDescendantFolderIds(userId, folderId, result = new Set()) {
  const children = await Folder.findAll({ where: { userId, parentFolderId: folderId }, attributes: ['id'] });
  for (const c of children) {
    result.add(c.id);
    await getDescendantFolderIds(userId, c.id, result);
  }
  return result;
}

/**
 * Delete one media row: remove file from disk/S3, update Storage + UserStoragePlan, destroy row.
 */
async function deleteMediaRecordAndFiles(media, userId) {
  try {
    if (media.url && media.url.startsWith('/upload/')) {
      const filePath = path.join(__dirname, '..', media.url);
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    } else if (media.s3Key) {
      await deleteFile(media.s3Key);
    }
  } catch (delError) {
    console.error('File delete error:', delError);
  }
  const sizeInGB = media.size / (1024 * 1024 * 1024);
  const storage = await Storage.findOne({ where: { userId } });
  if (storage) {
    const newUsedStorage = Math.max(0, parseFloat(storage.usedStorage) - sizeInGB);
    await storage.update({
      usedStorage: newUsedStorage,
      availableStorage: parseFloat(storage.totalStorage) - newUsedStorage,
    });
  }
  if (media.userPlanId) {
    const plan = await UserStoragePlan.findByPk(media.userPlanId);
    if (plan) {
      plan.usedStorage = Math.max(0, (Number(plan.usedStorage) || 0) - media.size);
      await plan.save();
    }
  }
  await media.destroy();
}

/**
 * Cascade-delete a folder tree for a user (same as DELETE /media/folders/:folderId).
 */
async function deleteFolderCascadeForUser(userId, folderIdNum) {
  const descendantIds = await getDescendantFolderIds(userId, folderIdNum, new Set());
  const allFolderIds = [folderIdNum, ...Array.from(descendantIds)];

  const mediaList = await Media.findAll({
    where: { userId, folderId: { [Op.in]: allFolderIds } },
  });

  for (const m of mediaList) {
    await deleteMediaRecordAndFiles(m, userId);
  }

  const remaining = new Set(allFolderIds);
  const folderRows = await Folder.findAll({ where: { userId, id: { [Op.in]: allFolderIds } } });
  const byId = new Map(folderRows.map((f) => [f.id, f]));

  while (remaining.size > 0) {
    const leafIds = [...remaining].filter((id) => {
      for (const rid of remaining) {
        if (rid !== id) {
          const child = byId.get(rid);
          if (child && Number(child.parentFolderId) === Number(id)) return false;
        }
      }
      return true;
    });
    if (leafIds.length === 0) {
      console.error('Folder cascade delete: could not resolve delete order', [...remaining]);
      throw new Error('Failed to delete folder tree');
    }
    await Folder.destroy({ where: { id: { [Op.in]: leafIds }, userId } });
    leafIds.forEach((id) => remaining.delete(id));
  }

  return {
    deletedFolders: allFolderIds.length,
    deletedMedia: mediaList.length,
  };
}

module.exports = {
  getDescendantFolderIds,
  deleteMediaRecordAndFiles,
  deleteFolderCascadeForUser,
};
