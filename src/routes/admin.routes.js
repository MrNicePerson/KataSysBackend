import { Router } from 'express'
import { requirePermission } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { getSnapshot, runCommand } from '../store/snapshotStore.js'
import { hasPermission } from '../models/User.js'
import { readSnapshot, send } from './helpers.js'

export const adminRouter = Router()

adminRouter.get('/settings', requirePermission('settings'), readSnapshot, (req, res) => {
  send(res, req.database.settings)
})

adminRouter.patch('/settings', requirePermission('settings'), asyncHandler(async (req, res) => {
  send(res, await runCommand('save-settings', req.body || {}))
}))

adminRouter.get('/backup', requirePermission('admin'), asyncHandler(async (_req, res) => {
  send(res, await getSnapshot())
}))

adminRouter.post('/backup/restore', requirePermission('admin'), asyncHandler(async (req, res) => {
  const result = await runCommand('restore-backup', { backup: req.body?.backup || req.body })
  send(res, result.record)
}))

adminRouter.get('/audit', (req, res, next) => requirePermission('activityHistory', req.query.export === 'true' ? 'export' : 'view')(req, res, next), requireSnapshot, asyncHandler(async (req, res) => {
  const { from, to, userId, action, module, search } = req.query
  const modulePermissions = {
    Sales: 'sales',
    Purchases: 'purchases',
    Stock: 'stock',
    'Customers / Returns': 'customers',
    Suppliers: 'suppliers',
    Cheques: 'cheques',
    'Daily Open & Closing': 'dailyClosing',
    'Payments & Finance': 'finance',
    'Users & Permissions': 'users',
    Settings: 'settings',
    Notifications: 'notifications',
  }
  const rows = (req.database.auditHistory || []).filter((entry) => {
    if (req.user.role !== 'admin' && (!entry.module || entry.module === 'General') && String(entry.userId || '') !== String(req.user._id)) return false
    if (entry.module === 'Customers / Returns' && !hasPermission(req.user, 'customers', 'view') && !hasPermission(req.user, 'returns', 'view')) return false
    if (entry.module && modulePermissions[entry.module] && !hasPermission(req.user, modulePermissions[entry.module], 'view')) return false
    const date = String(entry.date || entry.createdAt || '').slice(0, 10)
    if (from && date < from || to && date > to) return false
    if (userId && String(entry.userId || '') !== String(userId)) return false
    if (action && String(entry.action || 'Activity') !== action) return false
    if (module && String(entry.module || 'General') !== module) return false
    if (search) {
      const term = String(search).slice(0, 120).toLowerCase()
      if (![entry.description, entry.referenceId, entry.userName, entry.userId].some((value) => String(value || '').toLowerCase().includes(term))) return false
    }
    return true
  }).sort((left, right) => String(right.date || right.createdAt || '').localeCompare(String(left.date || left.createdAt || '')) || String(right.id).localeCompare(String(left.id)))
  const total = rows.length
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 10))
  let offset = 0
  if (req.query.cursor) {
    const separator = String(req.query.cursor).lastIndexOf('|')
    const cursorDate = separator >= 0 ? String(req.query.cursor).slice(0, separator) : ''
    const cursorId = separator >= 0 ? String(req.query.cursor).slice(separator + 1) : String(req.query.cursor)
    offset = rows.findIndex((entry) => String(entry.date || entry.createdAt || '') === cursorDate && String(entry.id) === cursorId) + 1
    if (!offset) offset = rows.findIndex((entry) => String(entry.date || entry.createdAt || '') < cursorDate)
    if (offset < 0) offset = rows.length
  }
  const page = rows.slice(offset, offset + limit)
  const last = page.at(-1)
  const nextCursor = offset + page.length < total && last ? `${last.date || last.createdAt}|${last.id}` : null
  send(res, {
    activities: page.map((entry) => ({ ...entry, userName: entry.userName || 'Legacy activity', module: entry.module || 'General', action: entry.action || 'Activity' })),
    total,
    nextCursor,
    users: [...new Map(rows.filter((entry) => entry.userId).map((entry) => [String(entry.userId), { id: String(entry.userId), name: entry.userName || 'Unknown user' }])).values()],
    modules: [...new Set(rows.map((entry) => entry.module || 'General'))].sort(),
    actions: [...new Set(rows.map((entry) => entry.action || 'Activity'))].sort(),
  })
}))

async function requireSnapshot(req, _res, next) {
  req.database = await getSnapshot()
  next()
}