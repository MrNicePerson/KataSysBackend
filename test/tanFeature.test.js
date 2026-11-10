import assert from 'node:assert/strict'
import test from 'node:test'
import { createEmptyDatabase, createSale, processCustomerReturn, receivePurchase, createTanType, updateSaleBill } from '../src/domain/businessLogic.js'

function setup() {
  const database = createEmptyDatabase()
  database.suppliers = [{ id: 'supplier-1', name: 'Cotton Supplier', supplierCode: 'COT', balance: 0 }]
  database.customers = [{ id: 'customer-1', name: 'Retailer', balance: 0 }]
  return database
}

test('Tan types are saved once and remain available in database state', () => {
  const first = createTanType(setup(), { name: 'Cotton' })
  const second = createTanType(first.database, { name: 'cotton' })
  assert.equal(second.database.tanTypes.length, 1)
  assert.equal(second.record.name, 'Cotton')
})

test('Tan purchase and sale use each Tan length and price, deduct whole Tan, and preserve return amounts', () => {
  const received = receivePurchase(setup(), {
    supplierId: 'supplier-1', date: '2026-10-27',
    items: [{ productType: 'tan', tanType: 'Cotton', tanName: 'Premium Cotton', quantity: 2, metersPerTan: 100, unitCost: 30000, salePrice: 32000 }],
    payments: { cash: 0, bank: 0, cheque: 0 },
  })
  const product = received.database.products[0]
  assert.equal(received.record.total, 60000)
  assert.equal(product.stockQuantity, 2)
  assert.equal(product.buyPricePerMeter, 300)
  assert.equal(product.salePricePerMeter, 320)
  received.database.products.push({ id: 'legacy-suit-1', name: 'Classic Suit', code: 'SUIT-1', stockQuantity: 3, reservedQuantity: 0, averageCost: 500, salePrice: 1000, active: true })

  const sold = createSale(received.database, { customerId: 'customer-1', items: [{ productId: product.id, quantity: 2, price: 320 }, { productId: 'legacy-suit-1', quantity: 1, price: 1000 }], payments: { cash: 65000 } })
  const line = sold.record.items[0]
  assert.equal(sold.record.subtotal, 65000)
  assert.equal(line.lineTotal, 64000)
  assert.equal(line.metersPerTan, 100)
  assert.equal(line.productType, 'tan')
  assert.equal(sold.record.items[1].productType, 'suit')
  assert.equal(sold.database.products[0].stockQuantity, 0)
  assert.equal(sold.database.products.find((entry) => entry.id === 'legacy-suit-1').stockQuantity, 2)
  assert.throws(() => createSale(sold.database, { customerId: 'customer-1', items: [{ productId: product.id, quantity: 1, price: 320 }], payments: { cash: 32000 } }), /Not enough available stock/)

  const edited = updateSaleBill(sold.database, { saleId: sold.record.id, items: [{ lineId: line.lineId, quantity: 2, price: 321 }], discount: 0, payments: { cash: 64200, bank: 0, cheque: 0 } })
  assert.equal(edited.record.items[0].lineTotal, 64200)
  assert.equal(edited.database.products[0].stockQuantity, 0)
  assert.equal(edited.database.products.find((entry) => entry.id === 'legacy-suit-1').stockQuantity, 3)

  const returned = processCustomerReturn(edited.database, { saleId: sold.record.id, lineId: line.lineId, quantity: 1, condition: 'sellable', refundType: 'khata' })
  assert.equal(returned.record.amount, 32100)
  assert.equal(returned.database.products[0].stockQuantity, 1)
  assert.equal(returned.database.customers[0].balance, -32100)
})

test('Tan purchase validation rejects zero length and fractional Tan quantities', () => {
  const database = setup()
  const base = { supplierId: 'supplier-1', date: '2026-10-27', items: [{ productType: 'tan', tanType: 'Cotton', tanName: 'Premium Cotton', quantity: 1, metersPerTan: 0, unitCost: 30000, salePrice: 32000 }], payments: {} }
  assert.throws(() => receivePurchase(database, base), /length must be greater than zero/)
  assert.throws(() => receivePurchase(database, { ...base, items: [{ ...base.items[0], quantity: 1.5, metersPerTan: 100 }] }), /positive whole number/)
})
