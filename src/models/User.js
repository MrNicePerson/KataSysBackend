import mongoose from 'mongoose'

export const PERMISSION_GROUPS = [
  { key: 'dashboard', label: 'Dashboard', actions: ['view'] },
  { key: 'sales', label: 'Sales / New Sale', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'financialView'] },
  { key: 'purchases', label: 'Purchases / Receive Stock', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'financialView'] },
  { key: 'stock', label: 'Products & Inventory', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export'] },
  { key: 'customers', label: 'Customers', actions: ['view', 'create', 'edit', 'delete', 'financialView', 'export'] },
  { key: 'suppliers', label: 'Suppliers', actions: ['view', 'create', 'edit', 'delete', 'financialView', 'export'] },
  { key: 'finance', label: 'Payments & Finance', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export', 'financialView'] },
  { key: 'cheques', label: 'Cheque Management', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export'] },
  { key: 'dailyClosing', label: 'Daily Open & Closing', actions: ['view', 'dailyOpeningCreate', 'dailyClosingCreate', 'dailyOpeningEdit', 'dailyClosingEdit', 'bankBalances', 'cashManagement', 'chequeRecords', 'chequeUpdates', 'withdrawals', 'dailyHistory', 'financialExport', 'closingApprove'] },
  { key: 'reports', label: 'Reports & Analytics', actions: ['view', 'export', 'financialView'] },
  { key: 'returns', label: 'Returns', actions: ['view', 'create', 'edit', 'delete', 'approve', 'export'] },
  { key: 'activityHistory', label: 'Activity History', actions: ['view', 'export'] },
  { key: 'notifications', label: 'Notifications', actions: ['view', 'manage'] },
  { key: 'settings', label: 'Settings', actions: ['view', 'edit', 'manage'] },
  { key: 'users', label: 'Users & Permissions', actions: ['view', 'create', 'edit', 'delete', 'manage'] },
  { key: 'orders', label: 'Orders & Held Bills', actions: ['view', 'create', 'edit', 'delete', 'approve'] },
  { key: 'claims', label: 'Claims', actions: ['view', 'create', 'edit', 'approve'] },
]

const moduleFallback = {
  dashboard: 'reports',
  purchases: 'stock',
  dailyClosing: 'finance',
  activityHistory: 'admin',
  users: 'admin',
  claims: 'stock',
}

function actionKey(module, action) {
  if (module === 'dailyClosing' && action !== 'view') return action
  return `${module}${action[0].toUpperCase()}${action.slice(1)}`
}

const userSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, enum: ['admin', 'staff'], default: 'staff' },
  active: { type: Boolean, default: true },
  permissions: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
  notificationPreferences: { type: mongoose.Schema.Types.Mixed, default: () => ({}) },
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
  dashboard: true,
  purchases: true,
  dailyClosing: true,
  activityHistory: true,
  notifications: true,
  users: true,
  claims: true,
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
  dashboard: false,
  purchases: true,
  dailyClosing: false,
  activityHistory: false,
  notifications: true,
  users: false,
  claims: true,
}

export function normalizePermissions(role, current = {}, updates = {}) {
  if (role === 'admin') return { ...ALL_PERMISSIONS }
  const permissions = { ...DEFAULT_STAFF_PERMISSIONS, ...current, ...updates, admin: false }
  permissions.dailyClosing = updates.dailyClosing ?? current.dailyClosing ?? updates.finance ?? current.finance ?? DEFAULT_STAFF_PERMISSIONS.dailyClosing
  for (const group of PERMISSION_GROUPS) {
    const fallback = permissions[group.key] ?? permissions[moduleFallback[group.key]] ?? false
    for (const action of group.actions) {
      const key = actionKey(group.key, action)
      if (typeof current[key] === 'boolean' || typeof updates[key] === 'boolean') permissions[key] = updates[key] ?? current[key]
      else delete permissions[key]
    }
    if (typeof permissions[group.key] !== 'boolean') permissions[group.key] = Boolean(fallback)
  }
  return permissions
}

export function hasPermission(user, permission, action = null) {
  if (user?.role === 'admin' || user?.permissions?.admin) return true
  const permissions = user?.permissions || {}
  if (action && action !== 'view') {
    const viewKey = actionKey(permission, 'view')
    if (permissions[viewKey] === false) return false
  }
  if (action) {
    const key = actionKey(permission, action)
    if (typeof permissions[key] === 'boolean') return permissions[key]
  }
  if (typeof permissions[permission] === 'boolean') return permissions[permission]
  const fallback = moduleFallback[permission]
  if (permission === 'notifications') return true
  return fallback ? Boolean(permissions[fallback]) : false
}

export function hasAnyModulePermission(user, permission) {
  if (user?.role === 'admin' || user?.permissions?.admin) return true
  const group = PERMISSION_GROUPS.find((entry) => entry.key === permission)
  if (group && group.actions.some((action) => typeof user?.permissions?.[actionKey(permission, action)] === 'boolean')) {
    return group.actions.some((action) => hasPermission(user, permission, action))
  }
  return hasPermission(user, permission)
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
