import { Router } from 'express'
import { asyncHandler } from '../middleware/errorHandler.js'
import { getSnapshot } from '../store/snapshotStore.js'
import { hasPermission, publicUser } from '../models/User.js'
import { send } from './helpers.js'

const collectionPermissions = {
  products: ['stock', 'sales', 'returns', 'orders', 'reports'],
  tanTypes: ['stock'],
  categories: ['stock', 'reports'],
  customers: ['customers', 'sales', 'returns', 'orders', 'reports'],
  suppliers: ['suppliers', 'stock', 'reports'],
  sales: ['sales', 'returns', 'customers', 'reports'],
  purchases: ['stock', 'suppliers', 'reports'],
  returns: ['returns', 'customers', 'reports'],
  supplierReturns: ['stock', 'suppliers', 'reports'],
  payments: ['customers', 'suppliers', 'finance', 'reports', 'dailyClosing'],
  cheques: ['cheques', 'customers', 'suppliers', 'finance', 'reports'],
  expenses: ['finance', 'reports', 'dailyClosing'],
  heldOrders: ['orders'],
  claims: ['stock', 'suppliers'],
  stockMovements: ['stock', 'reports'],
  dailyClosings: ['dailyClosing', 'reports'],
  financeEntries: ['finance', 'reports', 'dailyClosing'],
  installments: ['customers', 'finance'],
  bankAccounts: ['dailyClosing'],
  bankTransactions: ['dailyClosing'],
  bankBalanceRecords: ['dailyClosing'],
}

export const workspaceRouter = Router()

workspaceRouter.get('/', asyncHandler(async (req, res) => {
  const snapshot = await getSnapshot()
  const canCashManagement = hasPermission(req.user, 'dailyClosing', 'cashManagement')
    || hasPermission(req.user, 'dailyClosing', 'dailyOpeningCreate')
    || hasPermission(req.user, 'dailyClosing', 'dailyOpeningEdit')
    || hasPermission(req.user, 'dailyClosing', 'dailyClosingCreate')
    || hasPermission(req.user, 'dailyClosing', 'dailyClosingEdit')
    || hasPermission(req.user, 'dailyClosing', 'dailyHistory')
  const canFinanceData = hasPermission(req.user, 'finance', 'view') || hasPermission(req.user, 'reports', 'financialView')
  const canCustomerData = hasPermission(req.user, 'customers', 'view')
  const canSupplierData = hasPermission(req.user, 'suppliers', 'view')
  const canBankBalances = canFinanceData || hasPermission(req.user, 'dailyClosing', 'bankBalances')
  const canWithdrawals = canFinanceData || hasPermission(req.user, 'dailyClosing', 'withdrawals')
  const canRead = (collection) => {
    const canReportFinancials = hasPermission(req.user, 'reports', 'financialView')
    if (collection === 'cheques') return hasPermission(req.user, 'cheques', 'view') || hasPermission(req.user, 'dailyClosing', 'chequeRecords') || canReportFinancials
    if (collection === 'payments') return canFinanceData || canCustomerData || canSupplierData || canCashManagement
    if (collection === 'expenses' || collection === 'financeEntries') return canFinanceData || canCashManagement
    if (collection === 'bankAccounts') return canBankBalances || canWithdrawals
    if (collection === 'bankBalanceRecords') return canBankBalances
    if (collection === 'bankTransactions') return canBankBalances || canCashManagement
    if (collection === 'dailyClosings') return canReportFinancials || hasPermission(req.user, 'dailyClosing', 'view') && canCashManagement
    return collectionPermissions[collection].some((permission) => permission === 'reports'
      ? canReportFinancials
      : hasPermission(req.user, permission, 'view'))
  }
  const database = { version: snapshot.version }

  for (const [collection, requiredPermissions] of Object.entries(collectionPermissions)) {
    let rows = canRead(collection) ? snapshot[collection] : []
    if (collection === 'payments' && !canFinanceData) {
      rows = rows.filter((entry) => canCashManagement && entry.method === 'cash' || canCustomerData && entry.customerId || canSupplierData && entry.supplierId)
      if (canCashManagement && !canCustomerData && !canSupplierData) rows = rows.map((entry) => ({ ...entry, customerId: undefined, supplierId: undefined, referenceId: '' }))
    }
    if (collection === 'expenses' && !canFinanceData) rows = canCashManagement ? rows.filter((entry) => entry.method === 'cash') : []
    if (collection === 'financeEntries' && !canFinanceData) rows = canCashManagement ? rows.filter((entry) => entry.method === 'cash' && entry.type === 'capital') : []
    if (collection === 'bankAccounts' && canWithdrawals && !canBankBalances) rows = rows.map((entry) => ({ id: entry.id, name: entry.name, active: entry.active !== false, openingBalance: 0 }))
    if (collection === 'bankTransactions' && !canBankBalances) {
      if (canCashManagement) {
        rows = rows.filter((entry) => entry.destination === 'cash' || entry.source === 'cash').map((entry) => ({ ...entry, accountId: '', destinationAccountId: '' }))
      } else rows = []
    }
    database[collection] = rows
  }
  database.settings = hasPermission(req.user, 'settings', 'view') ? snapshot.settings : {}
  database.business = hasPermission(req.user, 'settings', 'view') ? snapshot.business : {}
  database.counters = hasPermission(req.user, 'sales', 'view') || hasPermission(req.user, 'stock', 'view') ? snapshot.counters : {}

  send(res, { user: publicUser(req.user), database, language: snapshot.settings.language === 'ur' ? 'ur' : 'en' })
}))
