const express = require('express');
const router = express.Router();
const userController = require('../controllers/user.controller');
const { protect } = require('../middleware/auth');

router.use(protect);
router.get('/profile', userController.getProfile);
router.patch('/profile', userController.updateProfile);
router.get('/orders', userController.getOrderHistory);
router.get('/stats', userController.getUserStats);

module.exports = router;
