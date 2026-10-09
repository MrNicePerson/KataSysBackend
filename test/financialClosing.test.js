import assert from 'node:assert/strict'
import test from 'node:test'
import {
  calculateBankBalanceSummary,
  calculateDailyClosing,
  createBankAccount,
  createEmptyDatabase,
  recordBankTransaction,
  saveBankBalances,
  saveDailyRecord,
  updateChequeDetails,
  updateChequeStatus,
} from '../src/domain/businessLogic.js'

const addAccount = (database, name, openingBalance = 0) => createBankAccount(database, { name, openingBalance }).record

test('withdrawals and transfers update bank balances without becoming business income or expenses', () => {
  let database = createEmptyDatabase()
  const source = addAccount(database, 'ABL', 1000)
  const destination = addAccount(database, 'Meezan', 200)
  database = { ...database, bankAccounts: [source, destination] }
  database = recordBankTransaction(database, { type: 'withdrawal', accountId: source.id, amount: 150, destination: 'cash', date: '2026-10-09' }).database
  database = recordBankTransaction(database, { type: 'transfer', accountId: source.id, destinationAccountId: destination.id, amount: 100, date: '2026-10-09' }).database
  database = recordBankTransaction(database, { type: 'withdrawal', accountId: source.id, destinationAccountId: destination.id, destination: 'account', amount: 25, date: '2026-10-09' }).database
  database = recordBankTransaction(database, { type: 'deposit', accountId: source.id, amount: 50, date: '2026-10-09' }).database

  const summary = calculateBankBalanceSummary(database, '2026-10-09')
  assert.equal(summary.accounts.find((entry) => entry.accountId === source.id).expectedBalance, 775)
  assert.equal(summary.accounts.find((entry) => entry.accountId === destination.id).expectedBalance, 325)
  assert.equal(database.financeEntries.length, 0)
  assert.equal(database.expenses.length, 0)
  assert.equal(calculateDailyClosing({ ...database, dailyClosings: [{ id: 'open', date: '2026-10-09', type: 'opening', amount: 300 }] }, '2026-10-09').expectedCash, 400)
})

test('daily bank closings preserve revisions, differences, and responsible user', () => {
  let database = createEmptyDatabase()
  const account = addAccount(database, 'UBL', 500)
  database = { ...database, bankAccounts: [account] }
  const actor = { _id: 'user-1', name: 'Finance User' }
  database = saveBankBalances(database, { date: '2026-10-09', balances: [{ accountId: account.id, closingBalance: 475, note: 'Bank fee' }] }, actor).database
  assert.equal(database.bankBalanceRecords[0].difference, -25)
  assert.equal(database.bankBalanceRecords[0].responsibleUserName, 'Finance User')
  database = saveBankBalances(database, { date: '2026-10-09', balances: [{ accountId: account.id, closingBalance: 470, note: 'Corrected statement' }] }, actor).database
  assert.equal(database.bankBalanceRecords.length, 2)
  assert.equal(calculateBankBalanceSummary(database, '2026-10-10').accounts[0].previousBalance, 470)
})

test('finalized daily cash closing corrections require a reason and retain the prior values', () => {
  let database = createEmptyDatabase()
  const actor = { _id: 'user-2', name: 'Admin' }
  database = saveDailyRecord(database, { type: 'opening', date: '2026-10-09', amount: 100 }, actor).database
  database = saveDailyRecord(database, { type: 'closing', date: '2026-10-09', amount: 120, counted: 118 }, actor).database
  assert.throws(() => saveDailyRecord(database, { type: 'closing', date: '2026-10-09', amount: 120, counted: 119 }, actor), /correction reason/i)
  database = saveDailyRecord(database, { type: 'closing', date: '2026-10-09', amount: 120, counted: 119, correctionReason: 'Recounted drawer' }, actor).database
  assert.equal(database.dailyClosings.find((entry) => entry.type === 'closing').correctionHistory[0].previous.counted, 118)
})

test('cheque rescheduling and status changes append actor-attributed history', () => {
  let database = createEmptyDatabase()
  database.customers.push({ id: 'customer-1', name: 'Retailer', balance: 500 })
  database.cheques.push({ id: 'cheque-1', partyType: 'customer', partyId: 'customer-1', amount: 200, number: 'CHQ-1', status: 'Pending', expectedClearanceDate: '2026-10-10' })
  const actor = { _id: 'user-3', name: 'Cashier' }
  database = updateChequeDetails(database, { chequeId: 'cheque-1', expectedClearanceDate: '2026-10-12', remarks: 'Supplier requested delay' }, actor).database
  let cheque = database.cheques[0]
  assert.equal(cheque.status, 'Rescheduled')
  assert.equal(cheque.rescheduleCount, 1)
  assert.equal(cheque.rescheduleHistory[0].userName, 'Cashier')
  database = updateChequeStatus(database, 'cheque-1', 'Deposited / Presented', { actor, remarks: 'Submitted to bank' }).database
  database = updateChequeStatus(database, 'cheque-1', 'Cleared', { actor }).database
  assert.equal(database.customers[0].balance, 300)
  assert.equal(database.payments.length, 1)
  database = updateChequeStatus(database, 'cheque-1', 'Bounced / Dishonoured', { actor, bounceReason: 'Insufficient funds', bankCharges: 75 }).database
  cheque = database.cheques[0]
  assert.equal(database.customers[0].balance, 500)
  assert.equal(cheque.bankCharges, 75)
  assert.equal(cheque.statusHistory.length, 4)
  assert.equal(database.payments.length, 2)
})
