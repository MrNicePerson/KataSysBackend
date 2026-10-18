import { Router } from 'express'
import { accountAudit, bankSummary, calculateAccountLedger, calculateDailyClosing, calculateReports, stockAudit } from '../domain/businessLogic.js'
import { requirePermission } from '../middleware/auth.js'
import { readSnapshot, send } from './helpers.js'

export const reportsRouter = Router()
reportsRouter.use(requirePermission('reports'), readSnapshot)

reportsRouter.get('/summary', requirePermission('reports', 'financialView'), (req, res) => {
  send(res, calculateReports(req.database, {
    from: req.query.from,
    to: req.query.to,
    period: req.query.period,
  }))
})

reportsRouter.get('/daily-closing', requirePermission('reports', 'financialView'), (req, res) => {
  const date = String(req.query.date || new Date().toISOString().slice(0, 10))
  const calculation = calculateDailyClosing(req.database, date)
  const closing = req.database.dailyClosings.find((entry) => entry.date === date && entry.type === 'closing') || null
  const opening = req.database.dailyClosings.find((entry) => entry.date === date && entry.type === 'opening') || null
  send(res, { ...calculation, openingRecord: opening, closingRecord: closing, counted: closing?.counted ?? null, difference: closing?.counted == null ? null : Number(closing.counted) - calculation.expectedCash })
})

reportsRouter.get('/stock-audit', requirePermission('reports', 'financialView'), (req, res) => {
  send(res, stockAudit(req.database))
})

reportsRouter.get('/account-audit', requirePermission('reports', 'financialView'), (req, res) => {
  send(res, accountAudit(req.database))
})

reportsRouter.get('/bank-summary', requirePermission('reports', 'financialView'), (req, res) => {
  send(res, bankSummary(req.database, req.query.date))
})

reportsRouter.get('/accounts/:type/:id/ledger', requirePermission('reports', 'financialView'), (req, res) => {
  send(res, calculateAccountLedger(req.database, req.params.type, req.params.id))
})