const express = require('express');
const router = express.Router();
const uploadController = require('../controllers/upload.controller');
const { protect } = require('../middleware/auth');

router.use(protect);

router.post(
  '/single',
  uploadController.uploadSingle,
  uploadController.uploadDocument
);

router.post(
  '/multiple',
  uploadController.uploadMultiple,
  uploadController.uploadMultipleDocuments
);

router.get('/signed-url', uploadController.getDownloadUrl);

module.exports = router;
