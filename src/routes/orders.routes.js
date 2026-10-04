import { Router } from 'express'
import { requirePermission } from '../middleware/auth.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const ordersRouter = Router()
ordersRouter.use(requirePermission('orders'), readSnapshot)

ordersRouter.get('/', (req, res) => {
  const { status, kind, customerId } = req.query
  let rows = req.database.heldOrders
  if (status) rows = rows.filter((entry) => entry.status === status)
  if (kind) rows = rows.filter((entry) => entry.kind === kind)
  if (customerId) rows = rows.filter((entry) => entry.customerId === customerId)
  send(res, rows)
})

ordersRouter.post('/', mutate('hold-order'))
ordersRouter.post('/:id/resume', mutate('release-held-order', { status: 200, input: (req) => ({ heldId: req.params.id }) }))
ordersRouter.post('/:id/cancel', mutate('discard-held-order', { status: 200, input: (req) => ({ heldId: req.params.id }) }))
ordersRouter.post('/:id/complete', mutate('complete-held-order', { input: (req) => ({ ...req.body, heldId: req.params.id }) }))
ordersRouter.post('/:id/deliver', mutate('partial-deliver-held-order', { input: (req) => ({ ...req.body, heldId: req.params.id }) }))