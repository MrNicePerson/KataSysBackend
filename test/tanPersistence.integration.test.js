import assert from 'node:assert/strict'
import test from 'node:test'
import mongoose from 'mongoose'
import { MongoMemoryServer } from 'mongodb-memory-server'
import { loadSnapshot, runCommand } from '../src/store/snapshotStore.js'

test('Tan type and received batch survive a MongoDB snapshot reload', async () => {
  const mongo = await MongoMemoryServer.create({ instance: { dbName: 'tan_persistence_test' } })
  try {
    await mongoose.connect(mongo.getUri(), { dbName: 'tan_persistence_test' })
    await loadSnapshot()
    const type = await runCommand('create-tan-type', { name: 'Cotton' })
    const supplier = await runCommand('create-supplier', { name: 'Cotton Supplier', supplierCode: 'COT' })
    const purchase = await runCommand('receive-purchase', {
      supplierId: supplier.id, date: '2026-10-27',
      items: [{ productType: 'tan', tanType: type.name, tanName: 'Premium Cotton', quantity: 2, metersPerTan: 100, unitCost: 30000, salePrice: 32000 }],
      payments: { cash: 0, bank: 0, cheque: 0 },
    })
    const refreshed = await loadSnapshot()
    const product = refreshed.products.find((entry) => entry.id === purchase.items[0].productId)
    assert.equal(refreshed.tanTypes[0].name, 'Cotton')
    assert.equal(product.productType, 'tan')
    assert.equal(product.batchNumber, purchase.batchNumber)
    assert.equal(product.metersPerTan, 100)
    assert.equal(product.buyPricePerMeter, 300)
    assert.equal(product.salePricePerMeter, 320)
    assert.equal(refreshed.purchases[0].total, 60000)
  } finally {
    await mongoose.disconnect()
    await mongo.stop()
  }
})
