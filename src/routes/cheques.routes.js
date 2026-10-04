import { Router } from 'express'
import { requirePermission } from '../middleware/auth.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const chequesRouter = Router()
chequesRouter.use(requirePermission('cheques'), readSnapshot)

chequesRouter.get('/', (req, res) => {
  const { direction, status, partyId } = req.query
  let rows = req.database.cheques
  if (direction) rows = rows.filter((entry) => entry.direction === direction)
  if (status) rows = rows.filter((entry) => entry.status === status)
  if (partyId) rows = rows.filter((entry) => entry.partyId === partyId)
  send(res, {
    incoming: rows.filter((entry) => entry.direction === 'received'),
    outgoing: rows.filter((entry) => entry.direction === 'given'),
    all: rows,
  })
})

chequesRouter.post('/', mutate('create-cheque'))
chequesRouter.patch('/:id/status', mutate('cheque-status', { status: 200, input: (req) => ({ chequeId: req.params.id, status: req.body.status }) }))
