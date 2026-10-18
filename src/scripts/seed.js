import bcrypt from 'bcryptjs'
import mongoose from 'mongoose'
import { env } from '../config/env.js'
import { connectDatabase } from '../config/db.js'
import { ALL_PERMISSIONS, User } from '../models/User.js'

try {
  await connectDatabase()

  if (await User.exists()) {
    console.log('An account already exists; no seed user was created.')
  } else {
    if (!env.seedAdminEmail || !env.seedAdminPassword) {
      throw new Error('Set SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD in Backend/.env before running the seed command.')
    }
    if (env.seedAdminPassword.length < 12) {
      throw new Error('SEED_ADMIN_PASSWORD must be at least 12 characters long.')
    }

    await User.create({
      name: 'Administrator',
      email: env.seedAdminEmail.toLowerCase(),
      passwordHash: await bcrypt.hash(env.seedAdminPassword, 12),
      role: 'admin',
      permissions: ALL_PERMISSIONS,
    })
    console.log('Initial administrator created.')
  }
} catch (error) {
  console.error(error.message)
  process.exitCode = 1
} finally {
  await mongoose.disconnect()
}