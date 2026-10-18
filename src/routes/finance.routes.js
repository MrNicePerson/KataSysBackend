import { Router } from 'express'
import { calculateBankBalanceSummary, calculateDailyClosing, filterByDateRange } from '../domain/businessLogic.js'
import { requirePermission } from '../middleware/auth.js'
import { hasPermission } from '../models/User.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const financeRouter = Router()
financeRouter.use(readSnapshot, requirePermission('finance'))

financeRouter.get('/expenses', (req, res) => {
  send(res, filterByDateRange(req.database.expenses, req.query.from, req.query.to))
})

financeRouter.post('/expenses', mutate('expense'))
financeRouter.get('/entries', (req, res) => {
  send(res, filterByDateRange(req.database.financeEntries, req.query.from, req.query.to))
})
financeRouter.post('/entries', mutate('finance'))
financeRouter.get('/banks', (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10))
  send(res, {
    accounts: req.database.bankAccounts || [],
    transactions: filterByDateRange(req.database.bankTransactions || [], req.query.from, req.query.to),
    summary: calculateBankBalanceSummary(req.database, date),
  })
})
financeRouter.post('/banks', mutate('create-bank-account'))
financeRouter.patch('/banks/:id', mutate('update-bank-account', { status: 200, input: (req) => ({ ...req.body, accountId: req.params.id }) }))
financeRouter.post('/banks/:id/transactions', mutate('bank-transaction', { input: (req) => ({ ...req.body, accountId: req.params.id }) }))
financeRouter.post('/banks/balances', mutate('save-bank-balances'))
financeRouter.get('/daily-closing', (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10))
  const canViewCash = ['cashManagement', 'dailyOpeningCreate', 'dailyOpeningEdit', 'dailyClosingCreate', 'dailyClosingEdit', 'dailyHistory']
    .some((permission) => hasPermission(req.user, 'dailyClosing', permission))
  if (!canViewCash) return send(res, { date, openingRecord: null, closingRecord: null, counted: null, difference: null })
  const calculation = calculateDailyClosing(req.database, date)
  const openingRecord = req.database.dailyClosings.find((entry) => entry.date === date && entry.type === 'opening') || null
  const closingRecord = req.database.dailyClosings.find((entry) => entry.date === date && entry.type === 'closing') || null
  send(res, {
    ...calculation,
    openingRecord,
    closingRecord,
    counted: closingRecord?.counted ?? null,
    difference: closingRecord?.counted == null ? null : Number(closingRecord.counted) - calculation.expectedCash,
  })
})
financeRouter.post('/daily-closing', mutate('daily-record'))
financeRouter.delete('/daily-closing/:id', mutate('delete-daily-record', {
  status: 200,
  input: (req) => ({ recordId: req.params.id }),
}))
financeRouter.post('/recovery/bulk', mutate('bulk-recovery'))
financeRouter.get('/installments', (req, res) => {
  const rows = req.query.customerId
    ? req.database.installments.filter((entry) => entry.customerId === req.query.customerId)
    : req.database.installments
  send(res, rows)
})
financeRouter.post('/installments', mutate('create-installment'))
financeRouter.post('/installments/:id/payments', mutate('installment-payment', { input: (req) => ({ ...req.body, installmentId: req.params.id }) }))