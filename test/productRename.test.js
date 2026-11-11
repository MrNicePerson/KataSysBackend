import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyDatabase, updateProductDetails } from '../src/domain/businessLogic.js'

test('article rename updates the code alias and retains stock identity', () => {
  const database = createEmptyDatabase()
  database.products = [{ id: 'p1', name: 'Brand', code: 'Old', article: 'Old', batchNumber: 'B1', stockQuantity: 2, salePrice: 100, averageCost: 80 }]
  const result = updateProductDetails(database, { productId: 'p1', code: 'Fiza_Noor' })
  assert.equal(result.record.article, 'Fiza_Noor')
  assert.equal(result.record.code, 'Fiza_Noor')
  assert.equal(result.record.id, 'p1')
  assert.equal(result.record.batchNumber, 'B1')
  assert.equal(result.database.products.length, 1)
})
