import assert from 'node:assert/strict'
import fs from 'node:fs'
import * as b from '../src/domain/businessLogic.js'

const date = '2026-10-23'
function fixture() {
  const db = b.createEmptyDatabase()
  db.customers = [{ id: 'c', name: 'Customer', balance: 100, openingBalance: 100 }]
  db.suppliers = [{ id: 'v', name: 'Supplier', supplierCode: 'SUP', balance: 100, openingBalance: 100 }]
  db.products = [{ id: 'p', name: 'Product', code: 'SKU', batchNumber: 'B1', size: 'M', stockQuantity: 10, reservedQuantity: 0, defectiveQuantity: 0, averageCost: 4, salePrice: 10, supplierId: 'v', active: true }]
  db.dailyClosings = [{ id: 'open', type: 'opening', date, amount: 100, branchId: 'default' }]
  db.bankAccounts = [{ id: 'a', name: 'HBL', openingBalance: 100, active: true }, { id: 'z', name: 'UBL', openingBalance: 0, active: true }]
  return db
}
const saleInput = (extra = {}) => ({ date, customerId: 'c', items: [{ productId: 'p', quantity: 2, price: 10 }], payments: { cash: 20 }, ...extra })
const sold = () => b.createSale(fixture(), saleInput()).database
const returnInput = db => ({ saleId: db.sales[0].id, lineId: db.sales[0].items[0].lineId, quantity: 1, date, refundType: 'khata' })
const payment = extra => ({ accountType: 'customer', accountId: 'c', method: 'cash', amount: 10, date, ...extra })
const cheque = extra => ({ direction: 'received', partyType: 'customer', partyId: 'c', number: 'CH1', bank: 'HBL', amount: 10, issued: date, dueDate: date, ...extra })
const bankTx = extra => ({ type: 'transfer', accountId: 'a', destinationAccountId: 'z', amount: 10, date, ...extra })
const cases = []
const add = (area, title, run) => cases.push({ id: String(cases.length + 1).padStart(3, '0'), area, title, run })
function reject(fn, db) {
  const before = structuredClone(db)
  let error
  try { fn() } catch (issue) { error = issue }
  assert.deepEqual(db, before, 'Rejected operation mutated source data')
  assert.ok(error, 'Invalid request was accepted')
  assert.ok(!(error instanceof TypeError) && !(error instanceof RangeError), 'Request crashed instead of validation')
}

// 001–010: sales and payment tampering.
for (const [title, patch] of [
  ['Empty sale', { items: [] }], ['Negative sale quantity', { items: [{ productId: 'p', quantity: -1, price: 10 }] }],
  ['Fractional sale quantity', { items: [{ productId: 'p', quantity: 1.5, price: 10 }] }],
  ['Missing stock reference', { items: [{ productId: 'missing', quantity: 1, price: 10 }] }],
  ['Oversell available stock', { items: [{ productId: 'p', quantity: 11, price: 10 }] }],
  ['Duplicate lines oversell stock', { items: [{ productId: 'p', quantity: 6, price: 10 }, { productId: 'p', quantity: 6, price: 10 }] }],
  ['Negative price', { items: [{ productId: 'p', quantity: 2, price: -10 }] }],
  ['Discount exceeds bill', { discount: 21 }], ['Cash overpayment', { payments: { cash: 21 } }],
  ['Cash plus cheque overpayment', { payments: { cash: 15, cheque: 10 } }],
]) add('Sales', title, () => { const db = fixture(); reject(() => b.createSale(db, saleInput(patch)), db) })

// 011–020: product and inventory integrity.
for (const [title, fn] of [
  ['Negative initial stock', db => b.createProduct(db, { name: 'New', stockQuantity: -1 })],
  ['Fractional initial stock', db => b.createProduct(db, { name: 'New', stockQuantity: 0.5 })],
  ['Blank product name', db => b.createProduct(db, { name: '  ' })],
  ['Duplicate product batch and size', db => b.createProduct(db, { name: 'Product', code: 'SKU', batchNumber: 'B1', size: 'M' })],
  ['Negative product cost', db => b.createProduct(db, { name: 'New', averageCost: -1 })],
  ['Infinite product price', db => b.createProduct(db, { name: 'New', salePrice: Infinity })],
  ['Remove more stock than exists', db => b.adjustStock(db, { productId: 'p', direction: 'remove', quantity: 11 })],
  ['Invalid stock direction', db => b.adjustStock(db, { productId: 'p', direction: 'hack', quantity: 1 })],
  ['Rename product to blank', db => b.updateProductDetails(db, { productId: 'p', name: ' ' })],
  ['Client supplied product ID collision', db => { const out = b.createProduct(db, { id: 'p', name: 'New' }); assert.notEqual(out.record.id, 'p') }],
]) add('Stock', title, () => { const db = fixture(); if (title.includes('ID collision')) fn(db); else reject(() => fn(db), db) })

// 021–030: customer returns.
for (const [title, change] of [
  ['Return without original sale', { saleId: 'missing' }], ['Return wrong invoice line', { lineId: 'missing' }],
  ['Negative return quantity', { quantity: -1 }], ['Fractional return quantity', { quantity: 0.5 }],
  ['Return exceeds sold quantity', { quantity: 3 }], ['Unknown refund type', { refundType: 'invented' }],
  ['Unknown return condition', { condition: 'invented' }],
]) add('Returns', title, () => { const db = sold(); reject(() => b.processCustomerReturn(db, { ...returnInput(db), ...change }), db) })
add('Returns', 'Repeated return exceeds remaining invoice quantity', () => { let db = sold(); db = b.processCustomerReturn(db, { ...returnInput(db), quantity: 2 }).database; reject(() => b.processCustomerReturn(db, returnInput(db)), db) })
add('Returns', 'Discounted full return cannot refund more than original invoice', () => { const db = b.createSale(fixture(), saleInput({ discount: 5, payments: { cash: 15 } })).database; const out = b.processCustomerReturn(db, { ...returnInput(db), quantity: 2, refundType: 'cash' }); assert.equal(out.record.amount, 15) })
add('Returns', 'Rejected return leaves source state untouched', () => { const db = sold(); reject(() => b.processCustomerReturn(db, { ...returnInput(db), quantity: 100 }), db) })

// 031–040: account payments, expenses, and recovery.
for (const [title, fn] of [
  ['Zero payment', db => b.recordAccountPayment(db, payment({ amount: 0 }))],
  ['Negative payment', db => b.recordAccountPayment(db, payment({ amount: -1 }))],
  ['NaN payment', db => b.recordAccountPayment(db, payment({ amount: 'NaN' }))],
  ['Missing payment account', db => b.recordAccountPayment(db, payment({ accountId: 'missing' }))],
  ['Unsupported payment method', db => b.recordAccountPayment(db, payment({ method: 'bitcoin' }))],
  ['Unsupported expense method', db => b.recordExpense(db, { amount: 10, method: 'invented' })],
  ['Zero expense', db => b.recordExpense(db, { amount: 0 })],
  ['Duplicate bulk recovery customer', db => b.bulkAccountRecovery(db, { items: [{ accountId: 'c', amount: 10 }, { accountId: 'c', amount: 10 }] })],
  ['Bulk recovery exceeds debt', db => b.bulkAccountRecovery(db, { items: [{ accountId: 'c', amount: 101 }] })],
  ['Rename account to blank', db => b.updateAccountDetails(db, { accountType: 'customer', accountId: 'c', name: ' ' })],
]) add('Payments', title, () => { const db = fixture(); reject(() => fn(db), db) })

// 041–050: cheque creation and lifecycle.
for (const [title, patch] of [
  ['Zero cheque', { amount: 0 }], ['Negative cheque', { amount: -1 }], ['Missing cheque customer', { partyId: 'missing' }],
  ['Invalid cheque party type', { partyType: 'invented' }], ['Invalid cheque direction', { direction: 'invented' }],
  ['Blank cheque number', { number: ' ' }], ['Blank cheque bank', { bank: ' ' }], ['Impossible cheque due date', { dueDate: '2026-02-30' }],
]) add('Cheques', title, () => { const db = fixture(); reject(() => b.createManualCheque(db, cheque(patch)), db) })
add('Cheques', 'Clearing the same cheque twice only credits once', () => { let db = b.createManualCheque(fixture(), cheque()).database; const id = db.cheques[0].id; db = b.updateChequeStatus(db, id, 'Cleared').database; const again = b.updateChequeStatus(db, id, 'Cleared').database; assert.equal(again.customers[0].balance, 90); assert.equal(again.payments.length, 1) })
add('Cheques', 'Negative bounce charges rejected', () => { const db = b.createManualCheque(fixture(), cheque()).database; reject(() => b.updateChequeStatus(db, db.cheques[0].id, 'Bounced', { bankCharges: -10 }), db) })

// 051–060: banks and transfers.
for (const [title, fn] of [
  ['Blank bank name', db => b.createBankAccount(db, { name: ' ' })], ['Duplicate bank name', db => b.createBankAccount(db, { name: 'hbl' })],
  ['Negative bank opening amount', db => b.createBankAccount(db, { name: 'New', openingBalance: -1 })],
  ['Transfer to same account', db => b.recordBankTransaction(db, bankTx({ destinationAccountId: 'a' }))],
  ['Transfer to missing account', db => b.recordBankTransaction(db, bankTx({ destinationAccountId: 'missing' }))],
  ['Negative transfer', db => b.recordBankTransaction(db, bankTx({ amount: -1 }))],
  ['Zero transfer', db => b.recordBankTransaction(db, bankTx({ amount: 0 }))],
  ['Impossible transfer date', db => b.recordBankTransaction(db, bankTx({ date: '2026-02-30' }))],
  ['Invalid bank balance', db => b.saveBankBalances(db, { date, balances: [{ accountId: 'a', closingBalance: 'NaN' }] })],
  ['Inactive transfer source', db => { db.bankAccounts[0].active = false; return b.recordBankTransaction(db, bankTx()) }],
]) add('Banks', title, () => { const db = fixture(); if (title === 'Inactive transfer source') db.bankAccounts[0].active = false; reject(() => fn(db), db) })

// 061–070: closing and dates.
for (const [title, fn] of [
  ['Closing without opening', db => { db.dailyClosings = []; return () => b.saveDailyRecord(db, { date, type: 'closing', amount: 0 }) }],
  ['Closing pending due cheque', db => { db.cheques = [{ ...cheque(), id: 'q', status: 'Pending' }]; return () => b.saveDailyRecord(db, { date, type: 'closing', amount: 0 }) }],
  ['Closing cheque under clearing', db => { db.cheques = [{ ...cheque(), id: 'q', status: 'Under Clearing' }]; return () => b.saveDailyRecord(db, { date, type: 'closing', amount: 0 }) }],
  ['Invalid daily record date', db => () => b.saveDailyRecord(db, { date: 'nonsense', type: 'opening', amount: 0 })],
  ['Impossible daily record date', db => () => b.saveDailyRecord(db, { date: '2026-02-30', type: 'opening', amount: 0 })],
  ['Negative opening cash', db => () => b.saveDailyRecord(db, { date, type: 'opening', amount: -1 })],
  ['Negative counted cash', db => () => b.saveDailyRecord(db, { date, type: 'closing', amount: 0, counted: -1 })],
  ['Unknown daily record type', db => () => b.saveDailyRecord(db, { date, type: 'invented', amount: 0 })],
  ['Sale without business-day opening', db => () => b.runDatabaseCommand(db, 'create-sale', saleInput(), { businessDate: '2026-10-24' })],
  ['Staff overwrites saved daily opening', db => () => b.saveDailyRecord(db, { date, type: 'opening', amount: 1 }, { role: 'staff', permissions: {} })],
]) add('Closing', title, () => { const db = fixture(); const attempt = fn(db); reject(attempt, db) })

// 071–080: corrupted backups.
for (const [title, change] of [
  ['Unsupported backup version', db => { db.version = 999 }], ['Missing products collection', db => { delete db.products }],
  ['Duplicate product IDs', db => db.products.push({ ...db.products[0] })], ['Null product row', db => db.products.push(null)],
  ['Product without ID', db => { delete db.products[0].id }], ['Dangling sale customer', db => db.sales.push({ id: 's', customerId: 'missing', items: [] })],
  ['Dangling sale product', db => db.sales.push({ id: 's', customerId: 'c', items: [{ productId: 'missing', quantity: 1 }] })],
  ['Dangling bank transaction', db => db.bankTransactions.push({ id: 't', accountId: 'missing' })],
  ['Negative stock backup', db => { db.products[0].stockQuantity = -1 }], ['Invalid numeric customer balance', db => { db.customers[0].balance = 'NaN' }],
]) add('Backup', title, () => { const db = fixture(); change(db); reject(() => b.validateBackup(db), db) })

// 081–090: held orders and reservations.
for (const [title, patch] of [
  ['Empty held order', { items: [] }], ['Invalid held order kind', { kind: 'invented' }],
  ['Negative held quantity', { items: [{ productId: 'p', quantity: -1 }] }], ['Fractional held quantity', { items: [{ productId: 'p', quantity: 1.1 }] }],
  ['Held order oversells stock', { items: [{ productId: 'p', quantity: 11 }] }], ['Missing held stock item', { items: [{ productId: 'missing', quantity: 1 }] }],
  ['Duplicate held lines overreserve stock', { items: [{ productId: 'p', quantity: 6 }, { productId: 'p', quantity: 6 }] }],
]) add('Held orders', title, () => { const db = fixture(); reject(() => b.recordHeldOrder(db, { items: [{ productId: 'p', quantity: 1 }], ...patch }), db) })
add('Held orders', 'Release unknown held order', () => { const db = fixture(); reject(() => b.releaseHeldOrder(db, 'missing'), db) })
add('Held orders', 'Cannot sell reserved stock', () => { const db = b.recordHeldOrder(fixture(), { items: [{ productId: 'p', quantity: 9 }] }).database; reject(() => b.createSale(db, saleInput()), db) })
add('Held orders', 'Releasing reservation restores availability once', () => { let db = b.recordHeldOrder(fixture(), { items: [{ productId: 'p', quantity: 3 }] }).database; const id = db.heldOrders[0].id; db = b.releaseHeldOrder(db, id).database; assert.equal(db.products[0].reservedQuantity, 0); reject(() => b.releaseHeldOrder(db, id), db) })

// 091–100: installments and financial integrity.
for (const [title, patch] of [
  ['Missing installment customer', { customerId: 'missing' }], ['Negative installment total', { totalAmount: -1 }],
  ['Zero installment count', { installmentCount: 0 }], ['Fractional installment count', { installmentCount: 1.5 }],
  ['Zero installment total', { totalAmount: 0 }], ['Impossible installment start date', { startDate: '2026-02-30' }],
]) add('Installments', title, () => { const db = fixture(); reject(() => b.createInstallmentPlan(db, { customerId: 'c', totalAmount: 100, installmentCount: 2, startDate: date, ...patch }), db) })
add('Installments', 'Installment overpayment', () => { const db = b.createInstallmentPlan(fixture(), { customerId: 'c', totalAmount: 100, installmentCount: 2, startDate: date }).database; reject(() => b.receiveInstallmentPayment(db, { installmentId: db.installments[0].id, amount: 101 }), db) })
add('Installments', 'Cheque installment does not count as paid before clearance', () => { const db = b.createInstallmentPlan(fixture(), { customerId: 'c', totalAmount: 100, installmentCount: 2, startDate: date }).database; reject(() => b.receiveInstallmentPayment(db, { installmentId: db.installments[0].id, amount: 50, method: 'cheque' }), db) })
add('Installments', 'Schedule amounts sum to total after rounding', () => { const out = b.createInstallmentPlan(fixture(), { customerId: 'c', totalAmount: 100, installmentCount: 3, startDate: date }); assert.equal(Math.round(out.record.schedule.reduce((sum, row) => sum + row.amount, 0) * 100), 10000) })
add('Installments', 'Completed plan cannot accept another payment', () => { let db = b.createInstallmentPlan(fixture(), { customerId: 'c', totalAmount: 100, installmentCount: 2, startDate: date }).database; const id = db.installments[0].id; db = b.receiveInstallmentPayment(db, { installmentId: id, amount: 100 }).database; reject(() => b.receiveInstallmentPayment(db, { installmentId: id, amount: 1 }), db) })

assert.equal(cases.length, 100)
const results = cases.map(({ run, ...entry }) => {
  try { run(); return { ...entry, status: 'PASS' } }
  catch (error) { return { ...entry, status: 'FAIL', error: error.message } }
})
const output = new URL('../reports/', import.meta.url)
fs.mkdirSync(output, { recursive: true })
const phase = process.argv.includes('--baseline') ? 'baseline' : 'after-fixes'
fs.writeFileSync(new URL(`adversarial-${phase}.json`, output), JSON.stringify({ date, scope: '100 deterministic domain misuse scenarios; isolated synthetic data; no production writes', results }, null, 2))
for (const row of results.filter(row => row.status === 'FAIL')) console.log(`${row.id} ${row.area}: ${row.title}: ${row.error}`)
console.log(`${phase}: ${results.filter(row => row.status === 'PASS').length}/100 passed`)
process.exitCode = results.some(row => row.status === 'FAIL') ? 1 : 0
