import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { hasPermission, User, publicUser } from '../models/User.js'

export function signToken(user) {
  return jwt.sign({ sub: String(user._id), role: user.role }, env.jwtSecret, { expiresIn: env.jwtExpiresIn })
}

export async function authRequired(req, res, next) {
  try {
    const header = req.headers.authorization || ''
    const token = header.startsWith('Bearer ') ? header.slice(7) : req.query.token
    if (!token) {
      const error = new Error('Sign in is required.')
      error.status = 401
      throw error
    }
    const payload = jwt.verify(token, env.jwtSecret)
    const user = await User.findById(payload.sub)
    if (!user || !user.active) {
      const error = new Error('This user is inactive or missing.')
      error.status = 401
      throw error
    }
    req.user = user
    next()
  } catch (error) {
    error.status = error.status || 401
    error.message = error.status === 401 ? error.message : 'Invalid or expired token.'
    next(error)
  }
}

export function requirePermission(permission, actionOverride = null) {
  return (req, res, next) => {
    if (!req.user) {
      const error = new Error('Sign in is required.')
      error.status = 401
      return next(error)
    }
    const path = req.path || ''
    let module = permission
    let action = actionOverride || (req.method === 'GET' ? 'view' : req.method === 'POST' ? 'create' : req.method === 'DELETE' ? 'delete' : 'edit')
    if (!actionOverride && req.method === 'PATCH' && path.endsWith('/status')) action = 'approve'
    if (permission === 'stock' && String(req.baseUrl || '').endsWith('/purchases')) module = 'purchases'
    if (permission === 'finance' && path.startsWith('/daily-closing')) {
      module = 'dailyClosing'
      if (req.method === 'GET') action = 'view'
      else if (req.method === 'POST' && req.body?.type) {
        const recordType = req.body.type === 'opening' ? 'Opening' : 'Closing'
        const existing = req.database?.dailyClosings?.some((entry) => entry.date === req.body.date
          && entry.type === req.body.type
          && String(entry.branchId || 'default') === String(req.body.branchId || 'default'))
        action = `daily${recordType}${existing ? 'Edit' : 'Create'}`
      } else if (req.method === 'DELETE') action = 'closingApprove'
    } else if (permission === 'finance' && path.startsWith('/banks')) {
      module = 'dailyClosing'
      action = path.includes('/transactions') ? 'withdrawals' : 'bankBalances'
    }
    if (module === 'dailyClosing' && action === 'dailyOpeningEdit' && req.user.role !== 'admin' && req.user.permissions?.admin !== true) {
      const error = new Error('Only an administrator can edit a saved daily opening.')
      error.status = 403
      return next(error)
    }
    if (hasPermission(req.user, module, action)) return next()
    const error = new Error('You do not have permission for this action.')
    error.status = 403
    next(error)
  }
}

export function currentUserPayload(user) {
  return publicUser(user)
}
