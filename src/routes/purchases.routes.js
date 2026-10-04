import { Router } from 'express'
import { localDateString } from '../domain/businessLogic.js'
import { nextReceivingBatch, receivingLabel } from '../domain/receiving.js'
import { requirePermission } from '../middleware/auth.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const purchasesRouter = Router()
purchasesRouter.use(requirePermission('stock'), readSnapshot)

purchasesRouter.get('/', (req, res) => {
  const { supplierId, q } = req.query
  let rows = req.database.purchases
  if (supplierId) rows = rows.filter((entry) => entry.supplierId === supplierId)
  if (q) {
    const needle = String(q).toLowerCase()
    rows = rows.filter((entry) => `${receivingLabel(entry)} ${entry.reference || ''} ${entry.supplier}`.toLowerCase().includes(needle))
  }
  send(res, rows)
})

// Keep the old receiving-only URL as an alias for existing clients.
purchasesRouter.get(['/next-batch', '/next-number'], (req, res) => {
  const supplier = req.database.suppliers.find((entry) => entry.id === req.query.supplierId)
  if (!supplier) return res.status(400).json({ error: 'Choose a supplier to preview the receiving Batch Number.' })
  send(res, nextReceivingBatch(req.database, supplier, String(req.query.date || localDateString())))
})

purchasesRouter.get('/:id', (req, res) => {
  const purchase = req.database.purchases.find((entry) => entry.id === req.params.id)
  if (!purchase) return res.status(404).json({ error: 'Purchase could not be found.' })
  send(res, purchase)
})

purchasesRouter.post('/', mutate('receive-purchase'))
