import { Router } from 'express'
import { calculateDailyClosing, filterByDateRange } from '../domain/businessLogic.js'
import { requirePermission } from '../middleware/auth.js'
import { mutate, readSnapshot, send } from './helpers.js'

export const financeRouter = Router()
financeRouter.use(requirePermission('finance'), readSnapshot)

financeRouter.get('/expenses', (req, res) => {
  send(res, filterByDateRange(req.database.expenses, req.query.from, req.query.to))
})

financeRouter.post('/expenses', mutate('expense'))
financeRouter.get('/entries', (req, res) => {
  send(res, filterByDateRange(req.database.financeEntries, req.query.from, req.query.to))
})
financeRouter.post('/entries', mutate('finance'))
financeRouter.get('/daily-closing', (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10))
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
financeRouter.post('/recovery/bulk', mutate('bulk-recovery'))
financeRouter.get('/installments', (req, res) => {
  const rows = req.query.customerId
    ? req.database.installments.filter((entry) => entry.customerId === req.query.customerId)
    : req.database.installments
  send(res, rows)
})
financeRouter.post('/installments', mutate('create-installment'))
financeRouter.post('/installments/:id/payments', mutate('installment-payment', { input: (req) => ({ ...req.body, installmentId: req.params.id }) }))