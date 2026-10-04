import test from 'node:test'
import assert from 'node:assert/strict'
import { collectionModels } from '../src/models/documents.js'
import { createEmptyDatabase, receivePurchase, processSupplierReturn, calculateAccountLedger, stockAudit } from '../src/domain/businessLogic.js'
import { nextReceivingBatch, receivingLabel } from '../src/domain/receiving.js'
import { withLock } from '../src/store/snapshotStore.js'

const fixture = () => ({ ...createEmptyDatabase(), suppliers: [
  { id: 'aa', name: 'Ali Imran', supplierCode: 'AA', balance: 0, openingBalance: 0 },
  { id: 'bb', name: 'Other supplier', supplierCode: 'BB', balance: 0, openingBalance: 0 },
] })
const input = (extra = {}) => ({ supplierId: 'aa', arrivalDate: '2026-10-03', reference: 'PUR-STALE', batchNumber: 'CLIENT-BATCH',
  items: ['Product A', 'Product B', 'Product C'].map((productName, index) => ({ productName, code: `P${index}`, quantity: 2, unitCost: 100, batchNumber: `OLD-ITEM-${index}` })), ...extra })

test('one receiving batch persists on the bill and every product, item and movement', async () => {
  const result = receivePurchase(fixture(), input())
  const { record: purchase, database } = result
  assert.equal(purchase.batchNumber, 'AA-03102026-001')
  assert.equal(purchase.supplierBillNumber, 1)
  assert.equal(purchase.supplierCode, 'AA')
  assert.equal(purchase.reference, undefined)
  assert.equal(purchase.items.length, 3)
  for (const item of purchase.items) {
    assert.equal(item.batchNumber, purchase.batchNumber)
    const product = database.products.find((product) => product.id === item.productId)
    assert.equal(product.batchNumber, purchase.batchNumber)
    assert.equal(product.purchaseId, purchase.id)
  }
  assert.ok(database.stockMovements.every((entry) => entry.note === purchase.batchNumber && entry.referenceId === purchase.id))
  const document = new collectionModels.purchases(purchase)
  await document.validate()
  const serialized = JSON.parse(JSON.stringify(document.toObject()))
  assert.equal(serialized.batchNumber, purchase.batchNumber)
  assert.equal(serialized.supplierCode, 'AA')
  assert.ok(serialized.items.every((item) => item.batchNumber === purchase.batchNumber))
  assert.ok(collectionModels.purchases.schema.indexes().some(([keys, options]) => keys.batchNumber === 1 && options.unique && options.partialFilterExpression))
})

test('subsequent receiving preserves older stock and carries numbering across dates and suppliers', () => {
  const first = receivePurchase(fixture(), input())
  const original = structuredClone(first.database.products)
  const second = receivePurchase(first.database, input({ arrivalDate: '2026-10-05', items: [{ productId: original[0].id, quantity: 4, unitCost: 110 }] }))
  assert.equal(second.record.batchNumber, 'AA-05102026-002')
  assert.deepEqual(second.database.products.slice(0, 3), original)
  const newProduct = second.database.products.find((product) => product.id === second.record.items[0].productId)
  assert.notEqual(newProduct.id, original[0].id)
  assert.equal(newProduct.purchaseId, second.record.id)
  assert.equal(newProduct.batchNumber, second.record.batchNumber)
  const other = receivePurchase(second.database, input({ supplierId: 'bb' }))
  assert.equal(other.record.batchNumber, 'BB-03102026-001')
})

test('saved high-water mark prevents reusing a number after records are archived', () => {
  const db = fixture()
  db.counters.supplierReceivings = { aa: 12 }
  assert.deepEqual(nextReceivingBatch(db, db.suppliers[0], '2026-10-03'), { batchNumber: 'AA-03102026-013', supplierBillNumber: 13 })
  db.counters = {}
  db.purchases = [{ supplierId: 'aa', reference: 'PUR-OLD', items: [{ batchNumber: 'AA-02102026-020' }] }]
  assert.equal(nextReceivingBatch(db, db.suppliers[0], '2026-10-03').supplierBillNumber, 21)
})

test('queued receiving saves assign distinct batches from the latest saved snapshot', async () => {
  let db = fixture()
  const save = () => withLock(async () => {
    const result = receivePurchase(db, input())
    await Promise.resolve()
    db = JSON.parse(JSON.stringify(result.database))
    return result.record.batchNumber
  })
  assert.deepEqual(await Promise.all([save(), save(), save()]), ['AA-03102026-001', 'AA-03102026-002', 'AA-03102026-003'])
})

test('supplier returns, supplier ledger and stock report retain the receiving batch', () => {
  const received = receivePurchase(fixture(), input({ payments: { cash: 100, bank: 100, cheque: 100 }, bankDetails: { bankName: 'Bank' }, cheques: [{ number: 'CHQ-55', bank: 'Bank', issued: '2026-10-03', amount: 100 }] }))
  const originalCheque = structuredClone(received.database.cheques[0])
  const returned = processSupplierReturn(received.database, { purchaseId: received.record.id, purchaseItemId: received.record.items[0].lineId, quantity: 1, reason: 'Damaged' })
  assert.equal(returned.record.batchNumber, received.record.batchNumber)
  assert.equal(returned.record.purchaseId, received.record.id)
  const movement = returned.database.stockMovements.find((entry) => entry.referenceId === returned.record.id)
  assert.ok(movement.note.includes(received.record.batchNumber))
  const ledger = calculateAccountLedger(returned.database, 'supplier', 'aa')
  const purchaseLine = ledger.entries.find((entry) => entry.id === received.record.id)
  assert.ok(purchaseLine.title.includes(received.record.batchNumber))
  assert.ok(stockAudit(returned.database).every((entry) => entry.batchNumber === received.record.batchNumber && entry.purchaseId === received.record.id))
  assert.deepEqual(returned.database.cheques[0], originalCheque)
  assert.equal(originalCheque.number, 'CHQ-55')
  assert.equal(originalCheque.referenceId, received.record.id)
  assert.ok(returned.database.payments.every((entry) => entry.referenceId === received.record.id))
})

test('legacy references and mixed historical item batches remain readable without rewriting', async () => {
  const legacy = { id: 'legacy-id', reference: 'PUR-201', supplierId: 'aa', date: '2020-01-01', total: 30, items: [{ batchNumber: 'OLD-A' }, { batchNumber: 'OLD-B' }] }
  const before = structuredClone(legacy)
  assert.equal(receivingLabel(legacy), 'PUR-201')
  assert.equal(receivingLabel({ id: 'id-only' }), 'id-only')
  assert.equal(receivingLabel({ items: [{ batchNumber: 'AA-03102026-001' }] }), 'AA-03102026-001')
  assert.equal(receivingLabel(null), '')
  await new collectionModels.purchases(legacy).validate()
  assert.deepEqual(legacy, before)
  const db = fixture()
  db.purchases.push(legacy)
  assert.ok(calculateAccountLedger(db, 'supplier', 'aa').entries.some((entry) => entry.title.includes('PUR-201')))
  assert.equal(receivePurchase(db, input()).record.batchNumber, 'AA-03102026-002')
})

test('missing supplier codes and invalid dates cannot generate manual or malformed batches', () => {
  const db = fixture()
  for (const arrivalDate of ['', '2026-02-30', 'invalid']) {
    if (arrivalDate) assert.throws(() => receivePurchase(db, input({ arrivalDate })), /date is invalid/)
  }
  db.suppliers[0].supplierCode = ''
  assert.throws(() => receivePurchase(db, input()), /Supplier Code/)
  assert.equal(db.purchases.length, 0)
})
