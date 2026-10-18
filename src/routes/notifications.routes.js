import { Router } from 'express'
import { Notification } from '../models/documents.js'
import { User } from '../models/User.js'
import { requirePermission } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { send } from './helpers.js'

export const notificationsRouter = Router()
notificationsRouter.use((req, res, next) => requirePermission('notifications', req.method === 'GET' ? 'view' : 'manage')(req, res, next))
const categories = ['sales', 'stock', 'payments', 'cheques', 'warnings', 'activity']
const mandatoryCategories = new Set(['cheques', 'warnings'])
const timezone = process.env.BUSINESS_TIMEZONE || 'Asia/Karachi'

function dateKey(date) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(date)
}

function shiftDate(value, amount) {
  const date = new Date(`${value}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() + amount)
  return date.toISOString().slice(0, 10)
}

function businessMidnight(value) {
  const instant = new Date(`${value}T00:00:00.000Z`)
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(instant).reduce((result, part) => ({ ...result, [part.type]: part.value }), {})
  const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  return new Date(instant.getTime() - (represented - instant.getTime()))
}

function boundsFor(value) {
  return { $gte: businessMidnight(value), $lt: businessMidnight(shiftDate(value, 1)) }
}

notificationsRouter.get('/', asyncHandler(async (req, res) => {
  const recipientId = String(req.user._id)
  const now = new Date()
  const today = dateKey(now)
  const tomorrow = shiftDate(today, 1)
  const yesterday = shiftDate(today, -1)
  const filter = String(req.query.filter || 'all')
  const query = { recipientId, archivedAt: null }
  if (filter === 'tomorrow') {
    query.deliveredAt = null
    query.scheduledAt = boundsFor(tomorrow)
  } else if (filter === 'upcoming') {
    query.deliveredAt = null
    query.scheduledAt = { $gt: now }
  } else {
    query.deliveredAt = { $ne: null }
    if (filter === 'unread') query.readAt = null
    if (filter === 'today') query.createdAt = boundsFor(today)
    if (filter === 'yesterday') query.createdAt = boundsFor(yesterday)
    if (filter === 'history') query.createdAt = { $lt: businessMidnight(yesterday) }
  }
  if (!['all', 'today', 'tomorrow', 'yesterday', 'upcoming', 'unread', 'history'].includes(filter)) return res.status(400).json({ error: 'Unknown notification filter.' })
  if (req.query.from || req.query.to) {
    query.createdAt = {
      ...(req.query.from ? { $gte: businessMidnight(String(req.query.from)) } : {}),
      ...(req.query.to ? { $lt: businessMidnight(shiftDate(String(req.query.to), 1)) } : {}),
    }
  }
  if (req.query.search) {
    const escaped = String(req.query.search).slice(0, 120).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    query.$or = [{ title: { $regex: escaped, $options: 'i' } }, { message: { $regex: escaped, $options: 'i' } }]
  }
  const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 30))
  if (req.query.cursor) query.createdAt = { ...(query.createdAt || {}), $lt: new Date(req.query.cursor) }
  const [rows, unreadCount, total] = await Promise.all([
    Notification.find(query).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean(),
    Notification.countDocuments({ recipientId, archivedAt: null, deliveredAt: { $ne: null }, readAt: null }),
    Notification.countDocuments(query),
  ])
  const hasMore = rows.length > limit
  if (hasMore) rows.pop()
  send(res, {
    notifications: rows,
    unreadCount,
    total,
    nextCursor: hasMore ? rows.at(-1)?.createdAt?.toISOString?.() || rows.at(-1)?.createdAt : null,
    preferences: req.user.notificationPreferences || {},
  })
}))

notificationsRouter.patch('/:id', asyncHandler(async (req, res) => {
  const changes = {}
  if (req.body?.status === 'read') changes.readAt = new Date()
  else if (req.body?.status === 'unread') changes.readAt = null
  else if (req.body?.status === 'archive') changes.archivedAt = new Date()
  else return res.status(400).json({ error: 'Choose read, unread, or archive.' })
  const notification = await Notification.findOneAndUpdate(
    { _id: req.params.id, recipientId: String(req.user._id) },
    { $set: changes },
    { new: true },
  ).lean()
  if (!notification) return res.status(404).json({ error: 'Notification could not be found.' })
  send(res, notification)
}))

notificationsRouter.post('/bulk', asyncHandler(async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.slice(0, 100) : []
  const action = req.body?.action
  const changes = action === 'read' ? { readAt: new Date() } : action === 'archive' ? { archivedAt: new Date() } : null
  if (!changes || (!ids.length && action !== 'read')) return res.status(400).json({ error: 'Choose notification IDs and a valid bulk action.' })
  const scope = { recipientId: String(req.user._id), archivedAt: null }
  if (ids.length) scope._id = { $in: ids }
  if (action === 'read') scope.deliveredAt = { $ne: null }
  const result = await Notification.updateMany(scope, { $set: changes })
  send(res, { updated: result.modifiedCount })
}))

notificationsRouter.patch('/preferences/categories', asyncHandler(async (req, res) => {
  const updates = req.body?.preferences
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return res.status(400).json({ error: 'Notification preferences are required.' })
  const sanitized = Object.fromEntries(categories
    .filter((category) => !mandatoryCategories.has(category) && typeof updates[category] === 'boolean')
    .map((category) => [category, updates[category]]))
  if (typeof updates.sound === 'boolean') sanitized.sound = updates.sound
  const user = await User.findById(req.user._id)
  user.notificationPreferences = { ...(user.notificationPreferences || {}), ...sanitized }
  await user.save()
  send(res, user?.notificationPreferences || {})
}))
