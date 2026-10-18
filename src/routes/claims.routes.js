import { Router } from 'express'
import { requirePermission } from '../middleware/auth.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const claimsRouter = Router()
claimsRouter.use(requirePermission('stock'), readSnapshot)

claimsRouter.get('/', (req, res) => {
  const { status, supplierId, productId } = req.query
  let rows = req.database.claims
  if (status) rows = rows.filter((entry) => entry.status === status)
  if (supplierId) rows = rows.filter((entry) => entry.supplierId === supplierId)
  if (productId) rows = rows.filter((entry) => entry.productId === productId)
  send(res, rows)
})

claimsRouter.post('/', mutate('create-claim'))
claimsRouter.patch('/:id/status', mutate('claim-status', { status: 200, input: (req) => ({ claimId: req.params.id, status: req.body.status, resolution: req.body.resolution }) }))
claimsRouter.patch('/:id', mutate('claim-update', { status: 200, input: (req) => ({ ...req.body, claimId: req.params.id }) }))