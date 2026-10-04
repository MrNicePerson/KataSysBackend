import { Router } from 'express'
import { customerStatement } from '../domain/businessLogic.js'
import { requirePermission } from '../middleware/auth.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const customersRouter = Router()
customersRouter.use(requirePermission('customers'), readSnapshot)

customersRouter.get('/', (req, res) => {
  const q = String(req.query.q || '').toLowerCase()
  const rows = q
    ? req.database.customers.filter((entry) => `${entry.name} ${entry.phone || ''} ${entry.city || ''}`.toLowerCase().includes(q))
    : req.database.customers
  send(res, rows)
})

customersRouter.get('/installments', (req, res) => {
  const rows = req.query.customerId
    ? req.database.installments.filter((entry) => entry.customerId === req.query.customerId)
    : req.database.installments
  send(res, rows)
})

customersRouter.get('/:id', (req, res) => {
  try {
    send(res, customerStatement(req.database, req.params.id))
  } catch (error) {
    res.status(404).json({ error: error.message })
  }
})

customersRouter.get('/:id/statement', (req, res) => {
  try {
    send(res, customerStatement(req.database, req.params.id))
  } catch (error) {
    res.status(404).json({ error: error.message })
  }
})

customersRouter.post('/', mutate('create-customer'))
customersRouter.patch('/:id', mutate('update-account', { status: 200, input: (req) => ({ ...req.body, accountType: 'customer', accountId: req.params.id }) }))
customersRouter.post('/:id/payments', mutate('account-payment', { input: (req) => ({ ...req.body, accountType: 'customer', accountId: req.params.id }) }))
customersRouter.post('/recovery/bulk', mutate('bulk-recovery'))
customersRouter.post('/installments', mutate('create-installment'))
customersRouter.post('/installments/:id/payments', mutate('installment-payment', { input: (req) => ({ ...req.body, installmentId: req.params.id }) }))
