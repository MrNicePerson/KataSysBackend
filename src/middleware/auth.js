import jwt from 'jsonwebtoken'
import { env } from '../config/env.js'
import { User, publicUser } from '../models/User.js'

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

export function requirePermission(permission) {
  return (req, res, next) => {
    if (!req.user) {
      const error = new Error('Sign in is required.')
      error.status = 401
      return next(error)
    }
    if (req.user.role === 'admin' || req.user.permissions?.admin || req.user.permissions?.[permission]) return next()
    const error = new Error('You do not have permission for this action.')
    error.status = 403
    next(error)
  }
}

export function currentUserPayload(user) {
  return publicUser(user)
}
