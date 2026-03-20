/**
 * Seed script to create initial admin user
 * Run: node scripts/seedAdmin.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const User = require('../models/User');

const seedAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const existingAdmin = await User.findOne({ role: 'admin' });
    if (existingAdmin) {
      console.log('Admin user already exists:', existingAdmin.email);
      process.exit(0);
    }

    const admin = await User.create({
      name: 'Super Admin',
      email: process.env.ADMIN_EMAIL || 'admin@smartxerox.com',
      phone: '9999999999',
      password: process.env.ADMIN_PASSWORD || 'Admin@123456',
      role: 'admin',
      isEmailVerified: true,
      isPhoneVerified: true,
      isActive: true,
    });

    console.log('✅ Admin user created successfully!');
    console.log('Email:', admin.email);
    console.log('Role:', admin.role);
    console.log('\n⚠️  Please change the admin password immediately after first login!');

  } catch (error) {
    console.error('❌ Seeding failed:', error.message);
  } finally {
    await mongoose.connection.close();
    process.exit(0);
  }
};

seedAdmin();
