import { Router } from 'express'
import { requirePermission } from '../middleware/auth.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const returnsRouter = Router()
returnsRouter.use(requirePermission('returns'), readSnapshot)

returnsRouter.get('/customers', (req, res) => {
  const { saleId, customerId, q } = req.query
  let rows = req.database.returns
  if (saleId) rows = rows.filter((entry) => entry.saleId === saleId)
  if (customerId) rows = rows.filter((entry) => entry.customerId === customerId)
  if (q) {
    const needle = String(q).toLowerCase()
    rows = rows.filter((entry) => `${entry.saleNumber} ${entry.code} ${entry.itemName}`.toLowerCase().includes(needle))
  }
  send(res, rows)
})

returnsRouter.post('/customers', mutate('customer-return'))

returnsRouter.get('/suppliers', (req, res) => {
  const { purchaseId, supplierId } = req.query
  let rows = req.database.supplierReturns
  if (purchaseId) rows = rows.filter((entry) => entry.purchaseId === purchaseId)
  if (supplierId) rows = rows.filter((entry) => entry.supplierId === supplierId)
  send(res, rows)
})

returnsRouter.post('/suppliers', mutate('supplier-return'))

returnsRouter.get('/sales/lookup', (req, res) => {
  const needle = String(req.query.q || '').trim().toLowerCase()
  const rows = req.database.sales.filter((sale) => {
    const haystack = [sale.number, sale.customer, sale.customerPhone, sale.id, ...(sale.items || []).flatMap((item) => [item.code, item.name])].join(' ').toLowerCase()
    return !needle || haystack.includes(needle)
  })
  send(res, rows)
})
