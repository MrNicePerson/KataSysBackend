import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { collectionModels } from '../src/models/documents.js'
import { loadSnapshot, runCommand } from '../src/store/snapshotStore.js'

test('supplier codes, receiving sequences and stock trace survive application reload', async (t) => {
  const dbName = `codex_receiving_trace_${process.pid}_${Date.now()}`
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017', { dbName, serverSelectionTimeoutMS: 2500 })
  } catch {
    t.skip('Local MongoDB is unavailable')
    return
  }
  try {
    await loadSnapshot()
    const ali = await runCommand('create-supplier', { name: 'Ali Imran', supplierCode: ' aa ' })
    const other = await runCommand('create-supplier', { name: 'Other Supplier', supplierCode: ' bb ' })
    assert.equal(ali.supplierCode, 'AA')
    assert.equal(other.supplierCode, 'BB')
    await assert.rejects(runCommand('create-supplier', { name: 'Duplicate', supplierCode: 'AA' }), /code already exists/)

    const receive = (supplierId, date, items) => runCommand('receive-purchase', { supplierId, date, items })
    const first = await receive(ali.id, '2026-10-03', [
      { productName: 'Product A', quantity: 2, unitCost: 100, salePrice: 150 },
      { productName: 'Product B', quantity: 3, unitCost: 200, salePrice: 250 },
    ])
    const appended = await runCommand('update-purchase', {
      purchaseId: first.id,
      supplierId: ali.id,
      appendStock: true,
      appendIdempotencyKey: 'append-product-c-once',
      appendItems: [{ productName: 'Product C', quantity: 2, unitCost: 70, salePrice: 110 }],
    })
    const retriedAppend = await runCommand('update-purchase', {
      purchaseId: first.id,
      supplierId: ali.id,
      appendStock: true,
      appendIdempotencyKey: 'append-product-c-once',
      appendItems: [{ productName: 'Product C', quantity: 2, unitCost: 70, salePrice: 110 }],
    })
    const second = await receive(ali.id, '2026-10-03', [{ productName: 'Product C', quantity: 1, unitCost: 300, salePrice: 400 }])
    const otherFirst = await receive(other.id, '2026-10-03', [{ productName: 'Product D', quantity: 4, unitCost: 50, salePrice: 90 }])
    const third = await receive(ali.id, '2026-10-05', [{ productName: 'Product E', quantity: 5, unitCost: 70, salePrice: 110 }])
    assert.equal(appended.id, first.id)
    assert.equal(appended.items.length, 3)
    assert.equal(retriedAppend.items.length, 3)
    assert.deepEqual([first.batchNumber, second.batchNumber, otherFirst.batchNumber, third.batchNumber], [
      'AA-03102026-001', 'AA-03102026-003', 'BB-03102026-001', 'AA-05102026-004',
    ])
    assert.equal(first.items.length, 2)
    assert.ok(first.items.every((item) => item.batchNumber === first.batchNumber))

    await collectionModels.purchases.insertMany([{ id: 'old-bill', supplierId: ali.id, supplier: ali.name, reference: 'PUR-OLD', date: '2020-01-01', items: [] }])
    await mongoose.disconnect()
    await mongoose.connect('mongodb://127.0.0.1:27017', { dbName, serverSelectionTimeoutMS: 2500 })
    const refreshed = await loadSnapshot()
    assert.equal(refreshed.suppliers.length, 2)
    assert.equal(refreshed.purchases.length, 5)
    assert.equal(refreshed.purchases.find((purchase) => purchase.id === 'old-bill').reference, 'PUR-OLD')
    const savedBill = refreshed.purchases.find((purchase) => purchase.id === first.id)
    const savedProducts = refreshed.products.filter((product) => product.purchaseId === first.id)
    const savedSupplier = refreshed.suppliers.find((supplier) => supplier.id === ali.id)
    assert.equal(savedBill.batchNumber, 'AA-03102026-001')
    assert.equal(savedBill.supplierCode, 'AA')
    assert.equal(savedSupplier.name, 'Ali Imran')
    assert.equal(savedBill.date, '2026-10-03')
    assert.equal(savedBill.items.length, 3)
    assert.equal(savedBill.total, 940)
    assert.equal(savedProducts.length, 3)
    assert.notEqual(savedBill.items[2].batchNumber, savedBill.batchNumber)
    for (const product of savedProducts) {
      const linkedItem = savedBill.items.find((item) => item.productId === product.id)
      assert.ok(linkedItem)
      assert.equal(product.batchNumber, linkedItem.batchNumber)
    }
  } finally {
    if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  }
})
