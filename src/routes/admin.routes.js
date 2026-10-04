import { Router } from 'express'
import { requirePermission } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { getSnapshot, runCommand } from '../store/snapshotStore.js'
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

adminRouter.get('/audit', requirePermission('admin'), requireSnapshot, (req, res) => {
  send(res, req.database.auditHistory)
})

async function requireSnapshot(req, _res, next) {
  req.database = await getSnapshot()
  next()
}