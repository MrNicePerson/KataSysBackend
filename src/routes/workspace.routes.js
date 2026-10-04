import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import { getSnapshot } from '../store/snapshotStore.js'
import { publicUser } from '../models/User.js'
import { send } from './helpers.js'

const collectionPermissions = {
  products: ['stock', 'sales', 'returns', 'orders', 'reports'],
  categories: ['stock', 'reports'],
  customers: ['customers', 'sales', 'returns', 'orders', 'reports'],
  suppliers: ['suppliers', 'stock', 'reports'],
  sales: ['sales', 'returns', 'customers', 'reports'],
  purchases: ['stock', 'suppliers', 'reports'],
  returns: ['returns', 'customers', 'reports'],
  supplierReturns: ['stock', 'suppliers', 'reports'],
  payments: ['customers', 'suppliers', 'finance', 'reports'],
  cheques: ['cheques', 'customers', 'suppliers', 'reports'],
  expenses: ['finance', 'reports'],
  heldOrders: ['orders'],
  claims: ['stock', 'suppliers'],
  stockMovements: ['stock', 'reports'],
  dailyClosings: ['finance', 'reports'],
  financeEntries: ['finance', 'reports'],
  installments: ['customers', 'finance'],
  auditHistory: ['admin'],
}

export const workspaceRouter = Router()

workspaceRouter.get('/', asyncHandler(async (req, res) => {
  const snapshot = await getSnapshot()
  const permissions = req.user.role === 'admin'
    ? new Set(Object.values(collectionPermissions).flat())
    : new Set(Object.entries(req.user.permissions?.toObject?.() || req.user.permissions || {})
      .filter(([, enabled]) => enabled)
      .map(([permission]) => permission))
  const canRead = (collection) => collectionPermissions[collection].some((permission) => permissions.has(permission))
  const database = { version: snapshot.version }

  for (const [collection, requiredPermissions] of Object.entries(collectionPermissions)) {
    database[collection] = canRead(collection) ? snapshot[collection] : []
  }
  database.settings = permissions.has('settings') ? snapshot.settings : {}
  database.business = permissions.has('settings') ? snapshot.business : {}
  database.counters = permissions.has('sales') || permissions.has('stock') ? snapshot.counters : {}

  send(res, { user: publicUser(req.user), database, language: snapshot.settings.language === 'ur' ? 'ur' : 'en' })
}))