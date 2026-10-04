import mongoose from 'mongoose'

const permissionSchema = new mongoose.Schema({
  sales: { type: Boolean, default: true },
  stock: { type: Boolean, default: true },
  suppliers: { type: Boolean, default: true },
  customers: { type: Boolean, default: true },
  cheques: { type: Boolean, default: true },
  returns: { type: Boolean, default: true },
  orders: { type: Boolean, default: true },
  finance: { type: Boolean, default: false },
  reports: { type: Boolean, default: true },
  settings: { type: Boolean, default: false },
  admin: { type: Boolean, default: false },
}, { _id: false })

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'staff'], default: 'staff' },
  active: { type: Boolean, default: true },
  permissions: { type: permissionSchema, default: () => ({}) },
}, { timestamps: true, versionKey: false })

export const User = mongoose.models.User || mongoose.model('User', userSchema, 'users')

export const ALL_PERMISSIONS = {
  sales: true,
  stock: true,
  suppliers: true,
  customers: true,
  cheques: true,
  returns: true,
  orders: true,
  finance: true,
  reports: true,
  settings: true,
  admin: true,
}

export const DEFAULT_STAFF_PERMISSIONS = {
  sales: true,
  stock: true,
  suppliers: true,
  customers: true,
  cheques: true,
  returns: true,
  orders: true,
  finance: false,
  reports: true,
  settings: false,
  admin: false,
}

export function normalizePermissions(role, current = {}, updates = {}) {
  if (role === 'admin') return { ...ALL_PERMISSIONS }
  return { ...DEFAULT_STAFF_PERMISSIONS, ...current, ...updates, admin: false }
}

export function publicUser(user) {
  if (!user) return null
  const row = user.toObject ? user.toObject() : user
  return {
    id: String(row._id),
    name: row.name,
    email: row.email,
    role: row.role,
    active: row.active,
    permissions: row.permissions,
    createdAt: row.createdAt,
  }
}
