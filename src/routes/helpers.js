import { asyncHandler } from '../middleware/errorHandler.js'
import { getSnapshot, runCommand } from '../store/snapshotStore.js'

export function send(res, data, status = 200) {
  res.status(status).json({ data })
}

export function mutate(command, { status = 201, input } = {}) {
  return asyncHandler(async (req, res) => {
    const payload = input ? input(req) : req.body || {}
    const record = await runCommand(command, payload)
    send(res, record, status)
  })
}

export const readSnapshot = asyncHandler(async (req, res, next) => {
  req.database = await getSnapshot()
  next()
})
