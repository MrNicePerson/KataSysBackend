import assert from 'node:assert/strict'
import bcrypt from 'bcryptjs'
import test from 'node:test'
import { normalizePermissions } from '../src/models/User.js'
import { changePasswordForUser } from '../src/routes/auth.routes.js'
import {
  calculateReports,
  createEmptyDatabase,
  createManualCheque,
  createSale,
  createClaim,
  bankSummary,
  completeHeldOrder,
  receivePurchase,
  recordStockCountAudit,
  processCustomerReturn,
  saveSettings,
  recordHeldOrder,
  partialDeliverHeldOrder,
  updateChequeStatus,
  updateClaimStatus,
  runDatabaseCommand,
  receivingBatchNumber,
  buildThermalInvoice,
  calculateAccountLedger,
  calculateDailyClosing,
  saleDayStatus,
} from '../src/domain/businessLogic.js'

function databaseFixture() {
  const database = createEmptyDatabase()
  database.customers = [{ id: 'customer-1', name: 'Customer One', balance: 0, openingBalance: 0 }]
  database.suppliers = [{ id: 'supplier-1', name: 'Supplier One', supplierCode: 'S1', balance: 0, openingBalance: 0 }]
  database.products = [{
    id: 'product-1',
    name: 'Sample Item',
    code: 'SKU-1',
    batchNumber: 'BATCH-1',
    size: 'M',
    rackLocation: 'R1',
    stockQuantity: 10,
    reservedQuantity: 0,
    defectiveQuantity: 0,
    averageCost: 4,
    salePrice: 10,
    supplierId: 'supplier-1',
    active: true,
  }]
  return database
}

test('sale commands require opening, reject a closed day, and isolate branches', () => {
  const date = '2026-10-15'
  const input = { items: [{ productId: 'product-1', quantity: 1, price: 10 }], payments: { cash: 10 } }
  const context = { businessDate: date, branchId: 'north' }
  const empty = databaseFixture()
  assert.throws(() => runDatabaseCommand(empty, 'create-sale', input, context), /Daily Opening is required/)

  const otherBranch = runDatabaseCommand(empty, 'daily-record', { type: 'opening', date, amount: 0 }, { businessDate: date, branchId: 'south' }).database
  assert.throws(() => runDatabaseCommand(otherBranch, 'create-sale', input, context), /Daily Opening is required/)

  const opened = runDatabaseCommand(otherBranch, 'daily-record', { type: 'opening', date, amount: 0 }, context).database
  const sold = runDatabaseCommand(opened, 'create-sale', input, context)
  assert.equal(sold.record.date, date)
  assert.equal(sold.record.branchId, 'north')

  const closed = runDatabaseCommand(sold.database, 'daily-record', { type: 'closing', date, amount: 10, counted: 10 }, context).database
  assert.throws(() => runDatabaseCommand(closed, 'create-sale', input, context), /Daily Closing has already been completed/)
  assert.equal(saleDayStatus(closed, context).canCreateSale, false)
  assert.equal(saleDayStatus(closed, { date: '2026-10-16', branchId: 'north' }).canCreateSale, false)
})

test('repeated opening writes remain one record under the serialized command model', () => {
  const date = '2026-10-15'
  const context = { businessDate: date, branchId: 'north' }
  const first = runDatabaseCommand(databaseFixture(), 'daily-record', { type: 'opening', date, amount: 100 }, context)
  const second = runDatabaseCommand(first.database, 'daily-record', { type: 'opening', date, amount: 120 }, context)
  assert.equal(second.database.dailyClosings.filter((entry) => entry.date === date && entry.type === 'opening' && entry.branchId === 'north').length, 1)
  assert.equal(second.record.amount, 120)
})

test('Recovery All uses existing cash payments, customer ledgers and daily cash for multiple accounts', () => {
  const database = databaseFixture()
  database.customers = [
    { id: 'ali', name: 'Ali Store', openingBalance: 15000, balance: 15000 },
    { id: 'khan', name: 'Khan Store', openingBalance: 8000, balance: 8000 },
    { id: 'skip', name: 'Skip Store', openingBalance: 3000, balance: 3000 },
  ]
  const original = structuredClone(database)
  const input = { method: 'cash', date: '2026-10-03', items: [{ accountId: 'ali', amount: 5000 }, { accountId: 'khan', amount: 8000 }] }
  const { database: saved, record: recoveries } = runDatabaseCommand(database, 'bulk-recovery', input)
  assert.deepEqual(saved.customers.map((customer) => customer.balance), [10000, 0, 3000])
  assert.equal(recoveries.length, 2)
  assert.equal(saved.payments.length, 2)
  assert.ok(saved.payments.every((payment) => payment.type === 'customer-payment' && payment.method === 'cash'))
  assert.deepEqual(saved.payments.map((payment) => payment.customerId).sort(), ['ali', 'khan'])
  assert.equal(calculateDailyClosing(saved, input.date).customerPayments, 13000)
  for (const [id, amount, balance] of [['ali', 5000, 10000], ['khan', 8000, 0]]) {
    const ledger = calculateAccountLedger(saved, 'customer', id)
    assert.equal(ledger.calculatedBalance, balance)
    assert.equal(ledger.storedBalance, balance)
    assert.ok(ledger.entries.some((entry) => entry.direction === 'credit' && entry.amount === amount && entry.title.includes('cash payment')))
  }
  assert.equal(calculateAccountLedger(saved, 'customer', 'skip').entries.length, 1)
  assert.deepEqual(database, original)
  for (const items of [
    [{ accountId: 'ali', amount: 15000.01 }],
    [{ accountId: 'ali', amount: 5000 }, { accountId: 'ali', amount: 1 }],
    [{ accountId: 'ali', amount: 1 }, { accountId: 'khan', amount: 8000.01 }],
  ]) assert.throws(() => runDatabaseCommand(database, 'bulk-recovery', { ...input, items }), /exceeds|Duplicate/)
  assert.deepEqual(database, original)
})

test('bank purchase validates details and amounts before changing stock or balances', () => {
  const database = databaseFixture()
  const input = { supplierId: 'supplier-1', items: [{ productId: 'product-1', quantity: 3, unitCost: 7 }], payments: { bank: 10 } }
  const original = structuredClone(database)
  assert.throws(() => receivePurchase(database, input), /bank\/account/)
  assert.throws(() => receivePurchase(database, { ...input, bankDetails: { bankName: ' ' } }), /bank\/account/)
  for (const bank of [21.01, -1, Infinity, 'invalid']) {
    assert.throws(() => receivePurchase(database, { ...input, payments: { bank }, bankDetails: { bankName: 'Test Bank' } }))
  }
  assert.deepEqual(database, original)
  const result = receivePurchase(database, { ...input, bankDetails: { bankName: ' Test Bank ', accountNumber: ' 00123 ', amount: 9999 } })
  assert.deepEqual(result.record.bankDetails, { bankName: 'Test Bank', accountNumber: '00123', amount: 10 })
  assert.deepEqual(result.database.payments[0].bankDetails, result.record.bankDetails)
  assert.equal(result.database.payments[0].referenceId, result.record.id)
  assert.equal(result.record.due, 11)
  assert.equal(result.database.products[0].stockQuantity, 10)
  assert.equal(result.database.products.find((product) => product.purchaseId === result.record.id).stockQuantity, 3)
  const full = receivePurchase(database, { ...input, payments: { bank: 21 }, bankDetails: { bankName: 'Test Bank' } })
  assert.equal(full.record.due, 0)
  assert.equal(full.record.bankDetails.accountNumber, '')
})

test('editing saved receipt fields leaves sale items, stock and balances unchanged', () => {
  const created = createSale(databaseFixture(), { customerId: 'customer-1', date: '2026-10-03', items: [{ productId: 'product-1', quantity: 2, price: 10 }], payments: { cash: 5 } })
  assert.equal(created.record.customer, 'Customer One')
  const before = structuredClone(created.database)
  const updated = runDatabaseCommand(created.database, 'update-sale-receipt', {
    saleId: created.record.id, padInvoiceNumber: ' PAD-7 ', customerPhone: '0300 1234567', customerAddress: 'Lahore', paymentDue: '2026-10-10',
  })
  assert.equal(updated.record.padInvoiceNumber, 'PAD-7')
  assert.equal(updated.record.paymentDue, '2026-10-10')
  assert.deepEqual(updated.record.items, before.sales[0].items)
  for (const key of ['products', 'customers', 'payments', 'stockMovements', 'cheques', 'returns']) assert.deepEqual(updated.database[key], before[key])
  const invoice = buildThermalInvoice(updated.database, created.record.id)
  assert.equal(invoice.customer.phone, '0300 1234567')
  assert.equal(invoice.customer.address, 'Lahore')
  assert.throws(() => runDatabaseCommand(created.database, 'update-sale-receipt', { saleId: 'missing' }), /could not be found/)
  assert.throws(() => runDatabaseCommand(created.database, 'update-sale-receipt', { saleId: created.record.id, paymentDue: 'bad' }), /valid payment due date/)
})

test('editing bill quantities and rates reconciles stock, balance and movements once', () => {
  const created = createSale(databaseFixture(), { customerId: 'customer-1', date: '2026-10-03', items: [{ productId: 'product-1', quantity: 2, price: 10 }], payments: { cash: 5 } })
  const before = structuredClone(created.database)
  const lineId = created.record.items[0].lineId
  const changed = runDatabaseCommand(before, 'update-sale-bill', { saleId: created.record.id, items: [{ lineId, quantity: 3, price: 12 }], discount: 1, padInvoiceNumber: 'PAD-42', customerPhone: '0300 0000042', customerAddress: 'Updated Road' })
  assert.equal(changed.record.id, created.record.id)
  assert.equal(changed.record.number, created.record.number)
  assert.equal(changed.record.total, 35)
  assert.equal(changed.record.due, 30)
  assert.equal(changed.record.padInvoiceNumber, 'PAD-42')
  assert.equal(changed.record.customerPhone, '0300 0000042')
  assert.equal(changed.record.customerAddress, 'Updated Road')
  assert.equal(changed.database.products[0].stockQuantity, before.products[0].stockQuantity - 1)
  assert.equal(changed.database.customers[0].balance, before.customers[0].balance + 15)
  assert.equal(changed.database.stockMovements.find((entry) => entry.referenceId === created.record.id).quantity, -3)
  assert.deepEqual(changed.database.payments, before.payments)
  assert.equal(changed.database.sales.length, 1)
  assert.equal(changed.database.auditHistory.at(0).referenceId, created.record.id)
  const restored = runDatabaseCommand(changed.database, 'update-sale-bill', { saleId: created.record.id, items: [{ lineId, quantity: 2, price: 10 }], discount: 0 })
  assert.equal(restored.database.products[0].stockQuantity, before.products[0].stockQuantity)
  assert.equal(restored.database.customers[0].balance, before.customers[0].balance)
  assert.deepEqual(before, created.database)
  assert.throws(() => runDatabaseCommand(before, 'update-sale-bill', { saleId: created.record.id, items: [{ lineId, quantity: 1, price: 1 }], discount: 0 }), /payments already recorded/)
  assert.throws(() => runDatabaseCommand(before, 'update-sale-bill', { saleId: created.record.id, items: [{ lineId, quantity: 99, price: 12 }], discount: 0 }), /Not enough available stock/)
  const returned = { ...before, returns: [{ id: 'return-1', saleId: created.record.id }] }
  assert.throws(() => runDatabaseCommand(returned, 'update-sale-bill', { saleId: created.record.id, items: [{ lineId, quantity: 3, price: 12 }], discount: 0 }), /linked to returns/)
})

test('editing a split sale payment updates its receipt, ledger entries and pending cheque', () => {
  const created = createSale(databaseFixture(), { customerId: 'customer-1', date: '2026-10-03', items: [{ productId: 'product-1', quantity: 4, price: 10 }], payments: { cash: 5 } })
  const lineId = created.record.items[0].lineId
  const changed = runDatabaseCommand(created.database, 'update-sale-bill', {
    saleId: created.record.id,
    items: [{ lineId, quantity: 4, price: 10 }],
    discount: 0,
    payments: { cash: 10, bank: 10, cheque: 15 },
    bankDetails: { bankName: 'Example Bank', accountNumber: '123' },
    cheque: { chequeNumber: 'CHQ-9', bankName: 'Cheque Bank', chequeDate: '2026-10-03', dueDate: '2026-10-15' },
  })
  assert.deepEqual(changed.record.payments, {
    cash: 10,
    bank: 10,
    cheque: 15,
    chequeDetails: {
      chequeNumber: 'CHQ-9', bankName: 'Cheque Bank', chequeDate: '2026-10-03', dueDate: '2026-10-15',
      amount: 15, status: 'Pending',
    },
  })
  assert.equal(changed.record.paid, 20)
  assert.equal(changed.record.due, 20)
  assert.equal(changed.database.payments.find((entry) => entry.method === 'cash' && entry.referenceId === created.record.id).amount, 10)
  assert.equal(changed.database.payments.find((entry) => entry.method === 'bank' && entry.referenceId === created.record.id).amount, 10)
  const cheque = changed.database.cheques.find((entry) => entry.sourceType === 'sale' && entry.referenceId === created.record.id)
  assert.equal(cheque.amount, 15)
  assert.equal(cheque.number, 'CHQ-9')
  assert.equal(cheque.bank, 'Cheque Bank')
  assert.equal(buildThermalInvoice(changed.database, created.record.id).cheques[0].amount, 15)
  assert.equal(buildThermalInvoice(changed.database, created.record.id).sale.payments.chequeDetails.chequeNumber, 'CHQ-9')
  assert.equal(buildThermalInvoice(changed.database, created.record.id).sale.payments.chequeDetails.amount, 15)
  assert.equal(changed.database.customers[0].balance, created.database.customers[0].balance - 15)
  const cleared = updateChequeStatus(changed.database, cheque.id, 'Cleared')
  assert.equal(cleared.database.customers[0].balance, changed.database.customers[0].balance - 15)
})

test('supplier codes are normalized, unique, and safely editable', () => {
  const database = databaseFixture()
  const first = runDatabaseCommand(database, 'create-supplier', { name: 'Ali Imran', supplierCode: ' aa ', openingBalance: 0 })
  assert.equal(first.record.supplierCode, 'AA')
  assert.throws(() => runDatabaseCommand(first.database, 'create-supplier', { name: 'Other', supplierCode: 'AA' }), /code already exists/)
  const second = runDatabaseCommand(first.database, 'create-supplier', { name: 'Other', supplierCode: ' bb ' })
  assert.equal(second.record.supplierCode, 'BB')
  const edited = runDatabaseCommand(second.database, 'update-account', { accountType: 'supplier', accountId: first.record.id, supplierCode: ' cc ', name: 'Ali Imran' })
  assert.equal(edited.record.supplierCode, 'CC')
  assert.throws(() => runDatabaseCommand(edited.database, 'update-account', { accountType: 'supplier', accountId: first.record.id, supplierCode: 'BB' }), /code already exists/)
})

test('receiving batch numbers use supplier code, date, and an independent saved receiving count', () => {
  const database = databaseFixture()
  database.suppliers[0].supplierCode = 'aa'
  database.suppliers.push({ id: 'supplier-2', name: 'Second', supplierCode: 'BB', balance: 0 })
  assert.equal(receivingBatchNumber(database, database.suppliers[0], '2026-10-03'), 'AA-03102026-001')
  database.purchases.push({ supplierId: 'supplier-1', items: [] })
  assert.equal(receivingBatchNumber(database, database.suppliers[0], '2026-10-05'), 'AA-05102026-002')
  assert.equal(receivingBatchNumber(database, database.suppliers[1], '2026-10-05'), 'BB-05102026-001')
  const received = receivePurchase(database, { supplierId: 'supplier-1', arrivalDate: '2026-10-10', items: [{ productName: 'New', quantity: 1, unitCost: 1 }] })
  assert.equal(received.record.items[0].batchNumber, 'AA-10102026-002')
})

test('one new delivery stores multiple independently detailed items and split payments once', () => {
  const database = databaseFixture()
  const input = {
    supplierId: 'supplier-1',
    arrivalDate: '2026-10-03',
    padNumber: 'PAD-NEW',
    items: [
      { productName: 'Summer Lawn', code: 'SUM-1', quantity: 2, unitCost: 10, salePrice: 16, season: 'Summer' },
      { productName: 'Winter Shawl', code: 'WIN-1', padNumber: 'PAD-ITEM', quantity: 3, unitCost: 20, salePrice: 32, season: 'Winter' },
    ],
    payments: { cash: 5, bank: 10, cheque: 15 },
    bankDetails: { bankName: 'Main Bank', accountNumber: '001' },
    cheques: [{ number: 'NEW-CH-1', bank: 'Cheque Bank', amount: 15, issued: '2026-10-03' }],
    idempotencyKey: 'new-delivery-multiple-items',
  }
  const created = receivePurchase(database, input)
  assert.equal(created.database.purchases.length, 1)
  assert.equal(created.record.items.length, 2)
  assert.ok(created.record.items.every((item) => item.batchNumber === created.record.batchNumber))
  assert.equal(created.record.items[0].padNumber, 'PAD-NEW')
  assert.equal(created.record.items[1].padNumber, 'PAD-ITEM')
  assert.equal(created.record.total, 80)
  assert.equal(created.record.paid, 30)
  assert.equal(created.record.due, 50)
  assert.equal(created.database.suppliers[0].balance, 50)
  assert.equal(created.database.products.length, 3)
  assert.equal(created.database.stockMovements.filter((entry) => entry.referenceId === created.record.id).length, 2)
  const duplicate = receivePurchase(created.database, input)
  assert.equal(duplicate.database.purchases.length, 1)
  assert.equal(duplicate.database.stockMovements.filter((entry) => entry.referenceId === created.record.id).length, 2)
})

test('receiving multiple supplier cheques links each pending cheque to the purchase', () => {
  const database = databaseFixture()
  const result = receivePurchase(database, {
    supplierId: 'supplier-1',
    arrivalDate: '2026-10-03',
    items: [{ productId: 'product-1', quantity: 3, unitCost: 7 }],
    payments: { cheque: 21 },
    cheques: [
      { number: 'CH-1', bank: 'Bank A', amount: 10, issued: '2026-10-03', expectedClearanceDate: '2026-10-10' },
      { number: 'CH-2', bank: 'Bank B', amount: 11, issued: '2026-10-03' },
    ],
  })
  assert.equal(result.record.payments.cheque, 21)
  assert.equal(result.record.cheques.length, 2)
  assert.equal(result.database.cheques.length, 2)
  assert.deepEqual(result.database.cheques.map((entry) => [entry.number, entry.bank, entry.amount, entry.partyId, entry.referenceId, entry.status]), [
    ['CH-1', 'Bank A', 10, 'supplier-1', result.record.id, 'Pending'],
    ['CH-2', 'Bank B', 11, 'supplier-1', result.record.id, 'Pending'],
  ])
  assert.equal(result.record.paid, 21)
  assert.equal(result.record.due, 0)
  assert.equal(result.database.suppliers[0].balance, 0)
})

test('receiving stock into a selected existing product updates its inventory exactly once', () => {
  const database = databaseFixture()
  database.products.push({ ...database.products[0], id: 'product-2', name: 'Second Item', code: 'SKU-2', stockQuantity: 8 })
  const input = {
    idempotencyKey: 'receive-existing-once',
    supplierId: 'supplier-1',
    arrivalDate: '2026-10-03',
    items: [{ existingProductId: 'product-1', productName: 'Sample Item', code: 'SKU-1', quantity: 3, unitCost: 6, salePrice: 12 }],
    payments: {},
  }
  const received = receivePurchase(database, input)
  const product = received.database.products.find((entry) => entry.id === 'product-1')
  assert.equal(received.database.products.length, 2)
  assert.equal(product.stockQuantity, 13)
  assert.equal(received.record.items[0].productId, 'product-1')
  assert.equal(received.database.stockMovements.filter((entry) => entry.type === 'purchase' && entry.referenceId === received.record.id).length, 1)
  const retried = receivePurchase(received.database, input)
  assert.equal(retried.database.products.find((entry) => entry.id === 'product-1').stockQuantity, 13)
  assert.throws(() => receivePurchase(received.database, {
    ...input,
    items: [{ ...input.items[0], existingProductId: 'product-2' }],
  }), /already used for different delivery details/)
})

test('editing a received purchase reconciles its original stock, supplier due and payment records once', () => {
  const received = receivePurchase(databaseFixture(), {
    supplierId: 'supplier-1',
    arrivalDate: '2026-10-03',
    items: [{ productName: 'New Item', code: 'NEW-1', quantity: 3, unitCost: 7, salePrice: 12 }],
    payments: { cash: 5 },
  })
  const line = received.record.items[0]
  const productId = line.productId
  const edit = {
    purchaseId: received.record.id,
    date: '2026-10-04',
    padNumber: 'PAD-2',
    items: [{ ...line, quantity: 4, unitCost: 8, salePrice: 14 }],
    payments: { cash: 5 },
  }
  const changed = runDatabaseCommand(received.database, 'update-purchase', edit)
  assert.equal(changed.record.total, 32)
  assert.equal(changed.record.due, 27)
  assert.equal(changed.record.date, '2026-10-04')
  assert.equal(changed.database.suppliers[0].balance, 27)
  assert.equal(changed.database.products.find((product) => product.id === productId).stockQuantity, 4)
  assert.equal(changed.database.stockMovements.filter((entry) => entry.type === 'purchase' && entry.referenceId === received.record.id).length, 1)
  assert.equal(changed.database.stockMovements.find((entry) => entry.type === 'purchase' && entry.referenceId === received.record.id).quantity, 4)
  const repeated = runDatabaseCommand(changed.database, 'update-purchase', edit)
  assert.equal(repeated.database.products.find((product) => product.id === productId).stockQuantity, 4)
  assert.equal(repeated.database.suppliers[0].balance, 27)
  assert.equal(repeated.database.payments.filter((entry) => entry.referenceId === received.record.id).length, 1)
})

test('adding stock to an existing delivery preserves its ID and original items and retries once', () => {
  const received = receivePurchase(databaseFixture(), {
    supplierId: 'supplier-1',
    arrivalDate: '2026-10-03',
    items: [{ productName: 'Original Item', code: 'ORG-1', quantity: 3, unitCost: 10, salePrice: 15 }],
    payments: { cash: 10 },
  })
  const purchaseId = received.record.id
  const originalLine = structuredClone(received.record.items[0])
  const existingProduct = received.database.products.find((product) => product.id === 'product-1')
  const input = {
    purchaseId,
    supplierId: 'supplier-1',
    appendStock: true,
    appendIdempotencyKey: 'append-stock-once',
    appendItems: [
      { productName: 'Second Item', code: 'SEC-1', padNumber: 'PAD-2', quantity: 2, unitCost: 5, salePrice: 9, season: 'Winter' },
      { existingProductId: existingProduct.id, productName: existingProduct.name, code: existingProduct.code, quantity: 1, unitCost: 4, salePrice: 11, season: 'Summer' },
    ],
  }
  const appended = runDatabaseCommand(received.database, 'update-purchase', input)
  assert.equal(appended.record.id, purchaseId)
  assert.deepEqual(appended.record.items[0], originalLine)
  assert.equal(appended.record.items.length, 3)
  assert.equal(appended.record.items[1].batchNumber, appended.record.items[2].batchNumber)
  assert.notEqual(appended.record.items[1].batchNumber, received.record.batchNumber)
  assert.equal(appended.record.items[1].padNumber, 'PAD-2')
  assert.equal(appended.record.total, 44)
  assert.equal(appended.record.paid, 10)
  assert.equal(appended.record.due, 34)
  assert.equal(appended.database.suppliers[0].balance, 34)
  assert.equal(appended.database.products.find((product) => product.code === 'SEC-1').stockQuantity, 2)
  assert.equal(appended.database.products.find((product) => product.id === existingProduct.id).stockQuantity, 11)
  assert.equal(appended.database.stockMovements.filter((entry) => entry.referenceId === purchaseId).length, 3)
  assert.equal(appended.database.payments.filter((entry) => entry.referenceId === purchaseId).length, 1)

  const retried = runDatabaseCommand(appended.database, 'update-purchase', input)
  assert.equal(retried.record.items.length, 3)
  assert.equal(retried.database.products.find((product) => product.code === 'SEC-1').stockQuantity, 2)
  assert.equal(retried.database.suppliers[0].balance, 34)
  assert.equal(retried.database.stockMovements.filter((entry) => entry.referenceId === purchaseId).length, 3)
  assert.throws(() => runDatabaseCommand(appended.database, 'update-purchase', {
    ...input,
    appendItems: [{ ...input.appendItems[0], quantity: 3 }],
  }), /already used for different item details/)
})

test('retrying a receiving submission with the same key does not duplicate stock or payments', () => {
  const input = {
    idempotencyKey: 'receive-once',
    supplierId: 'supplier-1',
    arrivalDate: '2026-10-03',
    items: [{ productName: 'New Item', code: 'NEW-1', quantity: 3, unitCost: 7, salePrice: 12 }],
    payments: { cash: 5 },
  }
  const received = receivePurchase(databaseFixture(), input)
  const retried = receivePurchase(received.database, input)
  assert.equal(retried.record.id, received.record.id)
  assert.equal(retried.database.purchases.length, received.database.purchases.length)
  assert.equal(retried.database.products.find((product) => product.code === 'NEW-1').stockQuantity, 3)
  assert.equal(retried.database.payments.filter((payment) => payment.referenceId === received.record.id).length, 1)
  assert.throws(() => receivePurchase(received.database, { ...input, items: [{ ...input.items[0], quantity: 4 }] }), /already used for different delivery details/)
})

test('receiving stock carries forward an existing supplier balance and records the purchase ledger details', () => {
  const database = databaseFixture()
  database.suppliers[0].balance = 20000
  const result = receivePurchase(database, {
    supplierId: 'supplier-1', arrivalDate: '2026-10-03', reference: 'PUR-EXAMPLE',
    items: [{ productId: 'product-1', quantity: 100, unitCost: 1000 }],
    payments: { cash: 20000, bank: 30000, cheque: 20000 },
    bankDetails: { bankName: 'Main Bank', accountNumber: '001' },
    cheques: [{ number: 'CH-90', bank: 'Cheque Bank', amount: 20000, issued: '2026-10-03' }],
  })
  assert.equal(result.record.total, 100000)
  assert.equal(result.record.paid, 70000)
  assert.equal(result.record.due, 30000)
  assert.equal(result.database.suppliers[0].balance, 50000)
  assert.equal(result.record.batchNumber, 'S1-03102026-001')
  assert.equal(result.record.reference, undefined)
  assert.deepEqual(result.record.payments, { cash: 20000, bank: 30000, cheque: 20000 })
  assert.equal(result.database.payments.filter((entry) => entry.referenceId === result.record.id).length, 3)
  assert.equal(result.database.payments.filter((entry) => entry.referenceId === result.record.id).find((entry) => entry.method === 'cheque').amount, 20000)
})

test('receiving cheque validation rejects missing, duplicate, mismatched, and over-total cheques', () => {
  const database = databaseFixture()
  const base = { supplierId: 'supplier-1', items: [{ productId: 'product-1', quantity: 3, unitCost: 7 }], payments: { cheque: 21 } }
  assert.throws(() => receivePurchase(database, base), /at least one cheque/)
  const cheque = { number: 'CH-1', bank: 'Bank', amount: 10, issued: '2026-10-03' }
  assert.throws(() => receivePurchase(database, { ...base, cheques: [cheque, { ...cheque }] }), /add up/)
  assert.throws(() => receivePurchase(database, { ...base, cheques: [{ ...cheque, amount: 22 }] }), /exceed/)
  assert.throws(() => receivePurchase(database, { ...base, cheques: [{ ...cheque, bank: '' }, { ...cheque, number: 'CH-2', amount: 11 }] }), /number, bank/)
})

test('sale applies split payment, due date, account balance, and stock change', () => {
  const result = createSale(databaseFixture(), {
    customerId: 'customer-1',
    items: [{ productId: 'product-1', quantity: 2, price: 12 }],
    payments: { cash: 8, bank: 5, cheque: 2 },
    bankDetails: { bankName: 'Main Bank', accountNumber: '001' },
    cheque: { chequeNumber: 'CH-9', bankName: 'Cheque Bank', chequeDate: '2026-10-04', dueDate: '2026-10-30' },
    paymentDue: '2026-10-30',
  })

  assert.equal(result.record.total, 24)
  assert.equal(result.record.due, 11)
  assert.equal(result.record.paymentDue, '2026-10-30')
  assert.deepEqual(result.record.payments, { cash: 8, bank: 5, cheque: 2 })
  assert.deepEqual(result.record.bankDetails, { bankName: 'Main Bank', accountNumber: '001', amount: 5 })
  assert.deepEqual(result.database.payments.find((payment) => payment.method === 'bank').bankDetails, result.record.bankDetails)
  assert.equal(result.database.cheques[0].amount, 2)
  assert.equal(result.database.cheques[0].number, 'CH-9')
  assert.equal(result.database.cheques[0].bank, 'Cheque Bank')
  assert.equal(result.database.cheques[0].issued, '2026-10-04')
  assert.equal(result.database.cheques[0].expectedClearanceDate, '2026-10-30')
  assert.equal(result.database.customers[0].balance, 11)
  assert.equal(result.database.products[0].stockQuantity, 8)
})

test('held order reserves stock and partial delivery retains the remainder', () => {
  const held = recordHeldOrder(databaseFixture(), {
    kind: 'reservation',
    items: [{ productId: 'product-1', quantity: 5, price: 10 }],
  })
  assert.equal(held.database.products[0].reservedQuantity, 5)

  const delivered = partialDeliverHeldOrder(held.database, {
    heldId: held.record.id,
    items: [{ productId: 'product-1', quantity: 2, price: 10 }],
    payments: { cash: 20 },
  })
  assert.equal(delivered.record.sale.total, 20)
  assert.equal(delivered.database.products[0].stockQuantity, 8)
  assert.equal(delivered.database.products[0].reservedQuantity, 3)
  assert.equal(delivered.record.heldOrder.items[0].remainingQuantity, 3)
})

test('receiving stock preserves supplier, batch, rack, and payable values', () => {
  const database = databaseFixture()
  database.products = []
  const result = receivePurchase(database, {
    supplierId: 'supplier-1',
    items: [{ productName: 'New Item', code: 'NEW-1', batchNumber: 'LOT-9', rackLocation: 'R4', quantity: 3, unitCost: 7, salePrice: 12 }],
    payments: { cash: 5 },
  })

  assert.equal(result.database.products[0].stockQuantity, 3)
  assert.equal(result.database.products[0].batchNumber, result.record.batchNumber)
  assert.notEqual(result.database.products[0].batchNumber, 'LOT-9')
  assert.equal(result.database.products[0].rackLocation, 'R4')
  assert.equal(result.database.suppliers[0].balance, 16)
})

test('customer return credits original net rate to khata and restores sellable stock', () => {
  const sale = createSale(databaseFixture(), {
    customerId: 'customer-1',
    items: [{ productId: 'product-1', quantity: 2, price: 9 }],
    payments: {},
  })
  const result = processCustomerReturn(sale.database, {
    saleId: sale.record.id,
    productId: 'product-1',
    quantity: 1,
    refundType: 'khata',
    condition: 'sellable',
  })

  assert.equal(result.record.amount, 9)
  assert.equal(result.database.customers[0].balance, 9)
  assert.equal(result.database.products[0].stockQuantity, 9)
})

test('sale exchange calculates refund from saved prices and records the cash outflow once', () => {
  const database = databaseFixture()
  database.products[0].stockQuantity = 5000
  database.products.push({
    id: 'replacement-1',
    name: 'Replacement Suit',
    code: 'SKU-2',
    stockQuantity: 2,
    reservedQuantity: 0,
    defectiveQuantity: 0,
    averageCost: 1000,
    salePrice: 2000,
    active: true,
  })
  const original = createSale(database, {
    customerId: 'customer-1',
    date: '2026-10-18',
    items: [{ productId: 'product-1', quantity: 5000, price: 1 }],
    payments: { cash: 5000 },
  })
  const returnedLine = original.record.items[0]
  const exchangeInput = {
    customerId: 'customer-1',
    date: '2026-10-18',
    refundType: 'cash',
    idempotencyKey: 'exchange-once',
    items: [
      { productId: 'replacement-1', quantity: 2, price: 2000 },
      { isReturn: true, originalSaleId: original.record.id, originalSaleLineId: returnedLine.lineId, quantity: 5000, returnQuantity: 5000, returnCondition: 'sellable' },
    ],
    payments: {},
  }
  const exchange = createSale(original.database, exchangeInput)
  assert.equal(exchange.record.subtotal, 4000)
  assert.equal(exchange.record.discount, 0)
  assert.equal(exchange.record.returnTotal, 5000)
  assert.equal(exchange.record.total, 0)
  assert.equal(exchange.record.refundDue, 1000)
  assert.equal(exchange.database.products.find((product) => product.id === 'product-1').stockQuantity, 5000)
  assert.equal(exchange.database.products.find((product) => product.id === 'replacement-1').stockQuantity, 0)
  assert.equal(exchange.database.returns[0].amount, 5000)
  assert.equal(exchange.database.payments.filter((entry) => entry.type === 'customer-refund' && entry.referenceId === exchange.record.id).length, 1)
  assert.equal(calculateDailyClosing(exchange.database, '2026-10-18').cashRefunds, 1000)
  assert.equal(calculateDailyClosing(exchange.database, '2026-10-18').expectedCash, 4000)

  const retried = createSale(exchange.database, exchangeInput)
  assert.equal(retried.record.id, exchange.record.id)
  assert.equal(retried.database.sales.length, exchange.database.sales.length)
  assert.equal(retried.database.payments.filter((entry) => entry.type === 'customer-refund').length, 1)
  assert.throws(() => createSale(exchange.database, { ...exchangeInput, discount: 5 }), /already used for different transaction details/)
  const khataExchange = createSale(original.database, { ...exchangeInput, refundType: 'khata', idempotencyKey: 'exchange-khata' })
  assert.equal(khataExchange.database.customers[0].balance, -1000)
  assert.equal(khataExchange.database.payments.filter((entry) => entry.type === 'customer-refund').length, 0)
  assert.equal(calculateDailyClosing(khataExchange.database, '2026-10-18').expectedCash, 5000)
})

test('sale exchange charges only the additional payment and creates no movement for an even exchange', () => {
  const database = databaseFixture()
  database.products.push({
    id: 'replacement-1',
    name: 'Replacement Suit',
    code: 'SKU-2',
    stockQuantity: 2,
    reservedQuantity: 0,
    defectiveQuantity: 0,
    averageCost: 4,
    salePrice: 15,
    active: true,
  })
  const original = createSale(database, {
    customerId: 'customer-1',
    date: '2026-10-18',
    items: [{ productId: 'product-1', quantity: 2, price: 10 }],
    payments: { cash: 20 },
  })
  const originalLine = original.record.items[0]
  const partialExchange = createSale(original.database, {
    customerId: 'customer-1',
    date: '2026-10-18',
    items: [
      { productId: 'replacement-1', quantity: 1, price: 15 },
      { isReturn: true, originalSaleId: original.record.id, originalSaleLineId: originalLine.lineId, quantity: 1, returnQuantity: 1 },
    ],
    payments: { cash: 5 },
  })
  assert.equal(partialExchange.record.returnTotal, 10)
  assert.equal(partialExchange.record.total, 5)
  assert.equal(partialExchange.database.payments.filter((entry) => entry.referenceId === partialExchange.record.id && entry.type === 'customer-payment')[0].amount, 5)
  assert.equal(calculateDailyClosing(partialExchange.database, '2026-10-18').cashRefunds, 0)
  assert.equal(calculateDailyClosing(partialExchange.database, '2026-10-18').expectedCash, 25)

  const evenExchange = createSale(partialExchange.database, {
    customerId: 'customer-1',
    date: '2026-10-18',
    items: [
      { productId: 'product-1', quantity: 1, price: 10 },
      { isReturn: true, originalSaleId: original.record.id, originalSaleLineId: originalLine.lineId, quantity: 1, returnQuantity: 1 },
    ],
    payments: {},
  })
  assert.equal(evenExchange.record.total, 0)
  assert.equal(evenExchange.record.refundDue, 0)
  assert.equal(evenExchange.database.payments.filter((entry) => entry.referenceId === evenExchange.record.id).length, 0)
  assert.equal(calculateDailyClosing(evenExchange.database, '2026-10-18').expectedCash, 25)
})

test('customer defective returns create one linked claim without applying inventory changes twice', () => {
  const original = createSale(databaseFixture(), {
    customerId: 'customer-1',
    date: '2026-10-18',
    items: [{ productId: 'product-1', quantity: 2, price: 10 }],
    payments: { cash: 20 },
  })
  const originalLine = original.record.items[0]
  const input = {
    customerId: 'customer-1',
    date: '2026-10-18',
    idempotencyKey: 'defective-return-once',
    items: [{ isReturn: true, originalSaleId: original.record.id, originalSaleLineId: originalLine.lineId, returnQuantity: 1, returnCondition: 'damaged' }],
    payments: {},
  }
  const returned = createSale(original.database, input, { actor: { id: 'user-1', name: 'Staff One' } })
  const claim = returned.database.claims[0]
  assert.equal(returned.database.claims.length, 1)
  assert.equal(claim.sourceType, 'customer-return')
  assert.equal(claim.sourceReturnId, returned.database.returns[0].id)
  assert.equal(claim.sourceSaleId, original.record.id)
  assert.equal(claim.customerId, 'customer-1')
  assert.equal(claim.createdById, 'user-1')
  assert.equal(returned.database.products[0].stockQuantity, 8)
  assert.equal(returned.database.products[0].defectiveQuantity, 1)
  assert.equal(returned.database.stockMovements.filter((entry) => entry.type === 'customer-return-defective').length, 1)

  const retried = createSale(returned.database, input)
  assert.equal(retried.database.claims.length, 1)
  assert.equal(retried.database.returns.length, 1)
  const updatedClaim = updateClaimStatus(returned.database, claim.id, 'Replacement', 'Supplier replacement requested')
  assert.equal(updatedClaim.database.products[0].stockQuantity, 8)
  assert.equal(updatedClaim.database.products[0].defectiveQuantity, 1)
})

test('password changes validate the current password and persist only a new password hash', async () => {
  const user = {
    passwordHash: await bcrypt.hash('old-password-123', 10),
    saves: 0,
    async save() { this.saves += 1 },
  }
  await assert.rejects(changePasswordForUser(user, { oldPassword: 'wrong-password', newPassword: 'new-password-123' }), /Old password is incorrect/)
  await assert.rejects(changePasswordForUser(user, { oldPassword: 'old-password-123', newPassword: 'short' }), /at least 12 characters/)
  await assert.rejects(changePasswordForUser(user, { oldPassword: 'old-password-123', newPassword: 'old-password-123' }), /different from the old password/)
  assert.equal(user.saves, 0)

  await changePasswordForUser(user, { oldPassword: 'old-password-123', newPassword: 'new-password-123' })
  assert.equal(user.saves, 1)
  assert.notEqual(user.passwordHash, 'new-password-123')
  assert.equal(await bcrypt.compare('new-password-123', user.passwordHash), true)
})

test('approved supplier defect claim moves quarantine quantity out of defective stock', () => {
  const created = createClaim(databaseFixture(), {
    productId: 'product-1',
    supplierId: 'supplier-1',
    quantity: 2,
    description: 'Damaged items',
  })
  assert.equal(created.database.products[0].stockQuantity, 8)
  assert.equal(created.database.products[0].defectiveQuantity, 2)

  const approved = updateClaimStatus(created.database, created.record.id, 'Approved', 'Credit approved')
  assert.equal(approved.database.products[0].defectiveQuantity, 0)
  assert.equal(approved.record.financialStatus, 'credited')
})

test('cleared incoming cheque records payment and reduces customer due', () => {
  const database = databaseFixture()
  database.customers[0].balance = 30
  const created = createManualCheque(database, {
    direction: 'received',
    partyType: 'customer',
    partyId: 'customer-1',
    amount: 12,
    number: 'CHQ-1',
    expectedClearanceDate: '2026-10-05',
  })
  const cleared = updateChequeStatus(created.database, created.record.id, 'Cleared')

  assert.equal(cleared.record.status, 'Cleared')
  assert.equal(cleared.database.customers[0].balance, 18)
  assert.equal(cleared.database.payments[0].method, 'cheque-cleared')
})

test('period report scopes sales and counts collected payment methods', () => {
  const database = databaseFixture()
  const sale = createSale(database, {
    customerId: 'customer-1',
    date: '2026-09-29',
    items: [{ productId: 'product-1', quantity: 1, price: 10 }],
    payments: { cash: 4, bank: 3 },
  })
  const report = calculateReports(sale.database, { from: '2026-09-29', to: '2026-09-29' })

  assert.equal(report.salesCount, 1)
  assert.equal(report.totals.netSales, 10)
  assert.equal(report.cashCollected, 4)
  assert.equal(report.bankCollected, 3)
})

test('completing a partially delivered order sells only its remaining quantity', () => {
  const held = recordHeldOrder(databaseFixture(), {
    kind: 'reservation',
    items: [{ productId: 'product-1', quantity: 5, price: 10 }],
  })
  const partial = partialDeliverHeldOrder(held.database, {
    heldId: held.record.id,
    items: [{ lineId: held.record.items[0].lineId, quantity: 2 }],
    payments: { cash: 20 },
  })
  const completed = completeHeldOrder(partial.database, {
    heldId: held.record.id,
    payments: { cash: 30 },
  })

  assert.equal(completed.record.items[0].quantity, 3)
  assert.equal(completed.database.products[0].stockQuantity, 5)
  assert.equal(completed.database.products[0].reservedQuantity, 0)
  assert.equal(completed.database.heldOrders.length, 0)
})

test('bank summary includes cleared incoming and outgoing cheques', () => {
  const database = databaseFixture()
  database.payments = [
    { id: 'bank-in', date: '2026-09-30', type: 'customer-payment', method: 'cheque-cleared', amount: 40 },
    { id: 'bank-out', date: '2026-09-30', type: 'supplier-payment', method: 'cheque-cleared', amount: 15 },
  ]
  const summary = bankSummary(database, '2026-09-30')

  assert.equal(summary.bankIn, 40)
  assert.equal(summary.bankOut, 15)
  assert.equal(summary.netBank, 25)
})

test('daily closing requires an opening saved for the same date', () => {
  const database = databaseFixture()
  const date = '2026-10-07'
  assert.throws(
    () => runDatabaseCommand(database, 'daily-record', { type: 'closing', date, amount: 20, counted: 18 }),
    /Save the daily opening/,
  )
  const opened = runDatabaseCommand(database, 'daily-record', { type: 'opening', date, amount: 10 })
  const closed = runDatabaseCommand(opened.database, 'daily-record', { type: 'closing', date, amount: 20, counted: 18 })
  assert.equal(closed.record.type, 'closing')
})

test('month-end closing requires a complete monthly stock audit and audit corrects counts', () => {
  const database = databaseFixture()
  const date = '2026-10-31'
  const opened = runDatabaseCommand(database, 'daily-record', { type: 'opening', date, amount: 10 })
  assert.throws(
    () => runDatabaseCommand(opened.database, 'daily-record', { type: 'closing', date, amount: 20, counted: 20 }),
    /Complete the monthly stock audit/,
  )

  const audited = runDatabaseCommand(opened.database, 'stock-audit', {
    period: 'monthly',
    date,
    items: [{ productId: 'product-1', countedAvailable: 7 }],
  })
  assert.equal(audited.record.periodKey, '2026-10')
  assert.equal(audited.record.items[0].difference, -3)
  assert.equal(audited.database.products[0].stockQuantity, 7)
  assert.equal(audited.database.stockAudits.length, 1)
  const closed = runDatabaseCommand(audited.database, 'daily-record', { type: 'closing', date, amount: 20, counted: 20 })
  assert.equal(closed.record.type, 'closing')
})

test('stock audit cannot be saved until every product is counted', () => {
  const database = databaseFixture()
  database.products.push({ id: 'product-2', name: 'Second Item', stockQuantity: 5, reservedQuantity: 0 })
  assert.throws(
    () => runDatabaseCommand(database, 'stock-audit', { period: 'monthly', date: '2026-10-31', items: [{ productId: 'product-1', countedAvailable: 10 }] }),
    /Review every stock item/,
  )
})

test('daily records can be deleted without leaving a closing without its opening', () => {
  const database = databaseFixture()
  const date = '2026-10-07'
  const opened = runDatabaseCommand(database, 'daily-record', { type: 'opening', date, amount: 10 })
  const closed = runDatabaseCommand(opened.database, 'daily-record', { type: 'closing', date, amount: 20, counted: 18 })
  assert.throws(
    () => runDatabaseCommand(closed.database, 'delete-daily-record', { recordId: opened.record.id }),
    /Delete the daily closing/,
  )
  const deletedClosing = runDatabaseCommand(closed.database, 'delete-daily-record', { recordId: closed.record.id })
  const deletedOpening = runDatabaseCommand(deletedClosing.database, 'delete-daily-record', { recordId: opened.record.id })
  assert.equal(deletedOpening.database.dailyClosings.length, 0)
  assert.throws(() => runDatabaseCommand(database, 'delete-daily-record', { recordId: 'missing' }), /could not be found/)
})

test('staff permissions cannot retain or receive administrator privileges', () => {
  const demoted = normalizePermissions('staff', {}, { finance: true, admin: true })
  const createdStaff = normalizePermissions('staff', {}, { admin: true, settings: true })
  const administrator = normalizePermissions('admin', {}, { sales: false })

  assert.equal(demoted.admin, false)
  assert.equal(demoted.finance, true)
  assert.equal(createdStaff.admin, false)
  assert.equal(administrator.admin, true)
  assert.equal(administrator.sales, true)
})

test('bounced cheques remain distinct and reverse the balance after prior clearance', () => {
  const database = databaseFixture()
  database.customers[0].balance = 30
  const created = createManualCheque(database, {
    direction: 'received',
    partyType: 'customer',
    partyId: 'customer-1',
    amount: 12,
  })
  const cleared = updateChequeStatus(created.database, created.record.id, 'Cleared')
  const bounced = updateChequeStatus(cleared.database, created.record.id, 'Bounced')

  assert.equal(bounced.record.status, 'Bounced')
  assert.equal(bounced.record.clearedAt, cleared.record.clearedAt)
  assert.equal(bounced.database.customers[0].balance, 30)
  assert.equal(bounced.database.payments.some((payment) => payment.type === 'cheque-reversal'), true)
})

test('shop language setting accepts English and Urdu only', () => {
  const database = createEmptyDatabase()
  const saved = saveSettings(database, { shopName: 'Test shop', stockThreshold: '10', language: 'ur' })

  assert.equal(saved.database.settings.language, 'ur')
  assert.throws(
    () => saveSettings(saved.database, { shopName: 'Test shop', stockThreshold: '10', language: 'fr' }),
    /Language must be English or Urdu/,
  )
})
