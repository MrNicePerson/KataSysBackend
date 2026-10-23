import test from 'node:test'
import assert from 'node:assert/strict'
import express from 'express'
import mongoose from 'mongoose'

process.env.NODE_ENV = 'test'
process.env.MONGODB_URI ||= 'mongodb://127.0.0.1:27017/unused-audit-default'
process.env.JWT_SECRET ||= 'isolated-http-audit-test-secret-32-characters'
const { User } = await import('../src/models/User.js')
const { authRequired, signToken } = await import('../src/middleware/auth.js')
const { financeRouter } = await import('../src/routes/finance.routes.js')
const { chequesRouter } = await import('../src/routes/cheques.routes.js')
const { errorHandler } = await import('../src/middleware/errorHandler.js')
const { loadSnapshot, runCommand, getSnapshot } = await import('../src/store/snapshotStore.js')

test('HTTP closing validation and authentication use isolated MongoDB data', async t => {
  const dbName = `codex_adversarial_http_${process.pid}_${Date.now()}`
  try { await mongoose.connect('mongodb://127.0.0.1:27017', { dbName, serverSelectionTimeoutMS: 2500 }) }
  catch { t.skip('Local MongoDB unavailable'); return }
  let server
  try {
    await loadSnapshot()
    const admin = await User.create({ name: 'Audit Admin', email: 'admin@audit.invalid', passwordHash: 'unused-test-hash', role: 'admin', active: true })
    const staff = await User.create({ name: 'Audit Staff', email: 'staff@audit.invalid', passwordHash: 'unused-test-hash', role: 'staff', active: true, permissions: {} })
    const token = signToken(admin)
    const date = '2026-10-23'
    const app = express()
    app.use(express.json())
    app.use('/finance', authRequired, financeRouter)
    app.use('/cheques', authRequired, chequesRouter)
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise(resolve => server.once('listening', resolve))
    const url = `http://127.0.0.1:${server.address().port}`
    const request = async (path, body, bearer = token, method = 'POST') => {
      const response = await fetch(url + path, { method, headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) }, body: JSON.stringify(body) })
      return { status: response.status, body: await response.json() }
    }
    await t.test('Unauthenticated closing denied with 401', async () => assert.equal((await request('/finance/daily-closing', {}, '')).status, 401))
    await t.test('Forged bearer denied with 401', async () => assert.equal((await request('/finance/daily-closing', {}, 'forged')).status, 401))
    await t.test('Staff without closing permission denied with 403', async () => assert.equal((await request('/finance/daily-closing', { date, type: 'closing', amount: 0 }, signToken(staff))).status, 403))
    await t.test('Impossible date produces validation error with 400', async () => {
      const result = await request('/finance/daily-closing', { date: '2026-02-30', type: 'opening', amount: 0 })
      assert.equal(result.status, 400); assert.match(result.body.error, /calendar date/)
    })
    assert.equal((await request('/finance/daily-closing', { date, type: 'opening', amount: 0 })).status, 201)
    const customer = await runCommand('create-customer', { name: 'HTTP Customer', openingBalance: 10 }, admin)
    const cheque = await runCommand('create-cheque', { direction: 'received', partyType: 'customer', partyId: customer.id, amount: 10, number: 'HTTP-CH1', bank: 'HBL', dueDate: date }, admin)
    await t.test('Pending due cheque blocks HTTP closing and persists no closing', async () => {
      const result = await request('/finance/daily-closing', { date, type: 'closing', amount: 0, counted: 0 })
      assert.equal(result.status, 400); assert.match(result.body.error, /HTTP-CH1/)
      assert.equal((await getSnapshot()).dailyClosings.filter(row => row.type === 'closing').length, 0)
    })
    await t.test('Invalid cheque status rejected over HTTP', async () => assert.equal((await request(`/cheques/${cheque.id}/status`, { status: 'invented' }, token, 'PATCH')).status, 400))
    await t.test('Status update permits closing through real route', async () => {
      assert.equal((await request(`/cheques/${cheque.id}/status`, { status: 'Cleared' }, token, 'PATCH')).status, 200)
      assert.equal((await request('/finance/daily-closing', { date, type: 'closing', amount: 0, counted: 0 })).status, 201)
      await loadSnapshot()
      assert.equal((await getSnapshot()).dailyClosings.filter(row => row.type === 'closing').length, 1)
    })
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    assert.match(mongoose.connection.name, /^codex_adversarial_http_/)
    await mongoose.connection.dropDatabase()
    await mongoose.disconnect()
  }
})
