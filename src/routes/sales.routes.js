import { Router } from 'express'
import { buildThermalInvoice, businessDateString, nextDocumentNumber, normalizeBranchId, saleDayStatus, searchSales } from '../domain/businessLogic.js'
import { requirePermission } from '../middleware/auth.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const salesRouter = Router()
salesRouter.use(requirePermission('sales'), readSnapshot)

salesRouter.get('/', (req, res) => {
  const { q, customerId, from, to } = req.query
  let rows = q ? searchSales(req.database, q) : req.database.sales
  if (customerId) rows = rows.filter((sale) => sale.customerId === customerId)
  if (from) rows = rows.filter((sale) => sale.date >= from)
  if (to) rows = rows.filter((sale) => sale.date <= to)
  send(res, rows)
})

salesRouter.get('/next-number', (req, res) => {
  send(res, { number: nextDocumentNumber(req.database, 'sale', 'INV') })
})

salesRouter.get('/day-status', (req, res) => {
  const branchId = normalizeBranchId(req.user?.branchId || req.database.business?.branchId)
  send(res, saleDayStatus(req.database, { date: businessDateString(), branchId }))
})

salesRouter.get('/:id', (req, res) => {
  const sale = req.database.sales.find((entry) => entry.id === req.params.id)
  if (!sale) return res.status(404).json({ error: 'Sale could not be found.' })
  send(res, sale)
})

salesRouter.get('/:id/invoice', (req, res) => {
  res.set('Cache-Control', 'no-store, max-age=0')
  send(res, buildThermalInvoice(req.database, req.params.id))
})

salesRouter.post('/', mutate('create-sale', {
  input: (req) => ({
    ...req.body,
    cheque: req.body.cheque || req.body.chequeDetails || {
      number: req.body.payments?.chequeDetails?.chequeNumber,
      bank: req.body.payments?.chequeDetails?.bankName,
      dueDate: req.body.payments?.chequeDetails?.dueDate || req.body.paymentDue,
    },
  }),
}))

salesRouter.patch('/:id/receipt', mutate('update-sale-receipt', {
  status: 200,
  input: (req) => ({ ...req.body, saleId: req.params.id }),
}))

salesRouter.patch('/:id', mutate('update-sale-bill', {
  status: 200,
  input: (req) => ({ ...req.body, saleId: req.params.id }),
}))
