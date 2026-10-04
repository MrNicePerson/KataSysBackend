import test from 'node:test'
import assert from 'node:assert/strict'
import mongoose from 'mongoose'
import { calculateAccountLedger, calculateDailyClosing } from '../src/domain/businessLogic.js'
import { collectionModels, Meta } from '../src/models/documents.js'
import { loadSnapshot, runCommand } from '../src/store/snapshotStore.js'

test('multiple cash recoveries persist with balances, ledger and daily cash after reload', async (t) => {
  const dbName = `codex_recovery_all_${process.pid}_${Date.now()}`
  try {
    await mongoose.connect('mongodb://127.0.0.1:27017', { dbName, serverSelectionTimeoutMS: 2500 })
  } catch {
    t.skip('Local MongoDB is unavailable')
    return
  }
  try {
    await loadSnapshot()
    const ali = await runCommand('create-customer', { name: 'Ali Store', openingBalance: 15000 })
    const khan = await runCommand('create-customer', { name: 'Khan Store', openingBalance: 8000 })
    const untouched = await runCommand('create-customer', { name: 'Other Store', openingBalance: 2000 })
    const date = '2026-10-03'
    const records = await runCommand('bulk-recovery', { method: 'cash', date, items: [{ accountId: ali.id, amount: 5000 }, { accountId: khan.id, amount: 8000 }] })
    assert.equal(records.length, 2)
    await assert.rejects(runCommand('bulk-recovery', { method: 'cash', date, items: [{ accountId: ali.id, amount: 10000.01 }] }), /exceeds the outstanding balance/)
    const insertPayments = collectionModels.payments.insertMany
    let failOnce = true
    collectionModels.payments.insertMany = function (...args) {
      if (failOnce) {
        failOnce = false
        throw new Error('Simulated payment write failure')
      }
      return insertPayments.apply(this, args)
    }
    try {
      await assert.rejects(runCommand('bulk-recovery', { method: 'cash', date, items: [{ accountId: ali.id, amount: 1000 }] }), /Simulated payment write failure/)
    } finally {
      collectionModels.payments.insertMany = insertPayments
    }
    assert.equal(await Meta.countDocuments({ id: 'pending-bulk-recovery' }), 0)
    const beforeInterruptedSave = await loadSnapshot()
    await Meta.create({ id: 'pending-bulk-recovery', value: {
      customers: beforeInterruptedSave.customers,
      payments: beforeInterruptedSave.payments,
      auditHistory: beforeInterruptedSave.auditHistory,
    } })
    await collectionModels.customers.deleteMany({})
    await mongoose.disconnect()
    await mongoose.connect('mongodb://127.0.0.1:27017', { dbName, serverSelectionTimeoutMS: 2500 })
    const saved = await loadSnapshot()
    assert.deepEqual([ali.id, khan.id, untouched.id].map((id) => saved.customers.find((customer) => customer.id === id).balance), [10000, 0, 2000])
    assert.equal(saved.payments.length, 2)
    assert.ok(saved.payments.every((payment) => payment.method === 'cash' && payment.type === 'customer-payment' && payment.date === date))
    assert.equal(calculateDailyClosing(saved, date).customerPayments, 13000)
    assert.equal(calculateAccountLedger(saved, 'customer', ali.id).calculatedBalance, 10000)
    assert.equal(calculateAccountLedger(saved, 'customer', khan.id).calculatedBalance, 0)
  } finally {
    if (mongoose.connection.readyState === 1 && mongoose.connection.name === dbName) await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  }
})
