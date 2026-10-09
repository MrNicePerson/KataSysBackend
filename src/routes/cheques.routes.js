import { Router } from 'express'
import { requirePermission } from '../middleware/auth.js'
import { hasPermission } from '../models/User.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const chequesRouter = Router()
const requireChequeAccess = (req, res, next) => {
  const action = req.method === 'GET' ? 'view' : req.method === 'POST' ? 'create' : req.path.endsWith('/status') ? 'approve' : 'edit'
  const dailyAction = req.method === 'GET' || req.method === 'POST' ? 'chequeRecords' : 'chequeUpdates'
  if (hasPermission(req.user, 'cheques', action) || hasPermission(req.user, 'dailyClosing', dailyAction)) return next()
  const error = new Error('You do not have permission to manage cheque records.')
  error.status = 403
  next(error)
}
chequesRouter.use(requireChequeAccess, readSnapshot)

chequesRouter.get('/', (req, res) => {
  const { direction, status, partyId, from, to, search } = req.query
  let rows = req.database.cheques
  if (direction) rows = rows.filter((entry) => entry.direction === direction)
  if (status) rows = rows.filter((entry) => entry.status === status)
  if (partyId) rows = rows.filter((entry) => entry.partyId === partyId)
  if (from) rows = rows.filter((entry) => String(entry.expectedClearanceDate || entry.issued || '') >= from)
  if (to) rows = rows.filter((entry) => String(entry.expectedClearanceDate || entry.issued || '') <= to)
  if (search) {
    const term = String(search).slice(0, 100).toLowerCase()
    rows = rows.filter((entry) => [entry.number, entry.party, entry.bank, entry.notes].some((value) => String(value || '').toLowerCase().includes(term)))
  }
  send(res, {
    incoming: rows.filter((entry) => entry.direction === 'received'),
    outgoing: rows.filter((entry) => entry.direction === 'given'),
    all: rows,
  })
})

chequesRouter.post('/', mutate('create-cheque'))
chequesRouter.patch('/:id/status', mutate('cheque-status', { status: 200, input: (req) => ({ ...req.body, chequeId: req.params.id }) }))
chequesRouter.patch('/:id/details', mutate('cheque-details', { status: 200, input: (req) => ({ ...req.body, chequeId: req.params.id }) }))
