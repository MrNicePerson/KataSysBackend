import { Router } from 'express'
import { supplierStatement } from '../domain/businessLogic.js'
import { requirePermission } from '../middleware/auth.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const suppliersRouter = Router()
suppliersRouter.use(requirePermission('suppliers'), readSnapshot)

suppliersRouter.get('/', (req, res) => {
  const q = String(req.query.q || '').toLowerCase()
  const rows = q
    ? req.database.suppliers.filter((entry) => `${entry.name} ${entry.phone || ''} ${entry.city || ''}`.toLowerCase().includes(q))
    : req.database.suppliers
  send(res, rows)
})

suppliersRouter.get('/:id', (req, res) => {
  try {
    send(res, supplierStatement(req.database, req.params.id))
  } catch (error) {
    res.status(404).json({ error: error.message })
  }
})

suppliersRouter.get('/:id/statement', (req, res) => {
  try {
    send(res, supplierStatement(req.database, req.params.id))
  } catch (error) {
    res.status(404).json({ error: error.message })
  }
})

suppliersRouter.post('/', mutate('create-supplier'))
suppliersRouter.patch('/:id', mutate('update-account', { status: 200, input: (req) => ({ ...req.body, accountType: 'supplier', accountId: req.params.id }) }))
suppliersRouter.post('/:id/payments', mutate('account-payment', { input: (req) => ({ ...req.body, accountType: 'supplier', accountId: req.params.id }) }))
