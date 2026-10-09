import { Router } from 'express'
import { requirePermission } from '../middleware/auth.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const productsRouter = Router()
productsRouter.use(requirePermission('stock'), readSnapshot)

productsRouter.get('/', (req, res) => {
  const q = String(req.query.q || '').trim().toLowerCase()
  const rows = q
    ? req.database.products.filter((product) => `${product.name} ${product.code} ${product.article || ''} ${product.batchNumber || ''}`.toLowerCase().includes(q))
    : req.database.products
  send(res, rows.map((product) => ({
    ...product,
    availableQuantity: Number(product.stockQuantity || 0) - Number(product.reservedQuantity || 0),
  })))
})

productsRouter.get('/movements', (req, res) => {
  const productId = req.query.productId
  const rows = productId ? req.database.stockMovements.filter((entry) => entry.productId === productId) : req.database.stockMovements
  send(res, rows)
})

productsRouter.get('/:id', (req, res) => {
  const product = req.database.products.find((entry) => entry.id === req.params.id)
  if (!product) return res.status(404).json({ error: 'Product could not be found.' })
  send(res, {
    ...product,
    availableQuantity: Number(product.stockQuantity || 0) - Number(product.reservedQuantity || 0),
    movements: req.database.stockMovements.filter((entry) => entry.productId === product.id),
  })
})

productsRouter.post('/', mutate('create-product'))
productsRouter.post('/stock-audit', mutate('stock-audit'))
productsRouter.patch('/:id', mutate('update-product', { status: 200, input: (req) => ({ ...req.body, productId: req.params.id }) }))
productsRouter.post('/:id/adjust-stock', mutate('adjust-stock', { input: (req) => ({ ...req.body, productId: req.params.id }) }))
