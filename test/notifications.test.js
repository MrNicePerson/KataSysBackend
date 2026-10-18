import assert from 'node:assert/strict'
import test from 'node:test'
import { describeActivity, stockLevelState } from '../src/domain/notifications.js'

test('sale activities include an invoice reference and total', () => {
  const notification = describeActivity('create-sale', {
    id: 'sale-42',
    number: 'INV-0042',
    customer: 'Ayesha',
    total: 25000,
  })

  assert.equal(notification.title, 'Sale INV-0042 recorded')
  assert.match(notification.message, /Ayesha/)
  assert.match(notification.message, /25,000/)
  assert.equal(notification.category, 'sales')
  assert.equal(notification.relatedId, 'sale-42')
})

test('bounced cheque activity is urgent and links to its cheque', () => {
  const notification = describeActivity('cheque-status', {
    id: 'cheque-25',
    number: 'CHQ-0025',
    amount: 50000,
    status: 'Bounced',
  })

  assert.equal(notification.title, 'Cheque bounced')
  assert.equal(notification.priority, 'urgent')
  assert.equal(notification.relatedType, 'cheque')
  assert.equal(notification.relatedId, 'cheque-25')
})

test('unsupported commands do not create activity notifications', () => {
  assert.equal(describeActivity('unmapped-command', { id: 'row-1' }), null)
})

test('stock threshold states distinguish normal, low, and out-of-stock quantities', () => {
  assert.equal(stockLevelState(11, 10), 'normal')
  assert.equal(stockLevelState(10, 10), 'low')
  assert.equal(stockLevelState(0, 10), 'out')
})
