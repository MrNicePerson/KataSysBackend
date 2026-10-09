import { asyncHandler } from '../middleware/errorHandler.js'
import { getSnapshot, runCommand } from '../store/snapshotStore.js'
import { createActivityNotifications, createStockLevelNotifications } from '../domain/notifications.js'

export function send(res, data, status = 200) {
  res.status(status).json({ data })
}

export function mutate(command, { status = 201, input } = {}) {
  return asyncHandler(async (req, res) => {
    const payload = input ? input(req) : req.body || {}
    const record = await runCommand(command, payload, req.user)
    try {
      await createActivityNotifications(command, record, req.user)
      await createStockLevelNotifications(command, record, req.user)
    } catch (error) {
      console.error('Could not persist activity notification:', error.message)
    }
    send(res, record, status)
  })
}

export const readSnapshot = asyncHandler(async (req, res, next) => {
  req.database = await getSnapshot()
  next()
})
