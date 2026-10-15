import bcrypt from 'bcryptjs'
import { Router } from 'express'
import { ALL_PERMISSIONS, User, normalizePermissions, publicUser } from '../models/User.js'
import { authRequired, currentUserPayload, requirePermission, signToken } from '../middleware/auth.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { appendAuditEntry, getSnapshot } from '../store/snapshotStore.js'

export const authRouter = Router()

authRouter.get('/bootstrap', asyncHandler(async (_req, res) => {
  const [userCount, snapshot] = await Promise.all([User.countDocuments(), getSnapshot()])
  res.json({ registrationAvailable: userCount === 0, language: snapshot.settings.language === 'ur' ? 'ur' : 'en' })
}))

authRouter.post('/register', asyncHandler(async (req, res) => {
  const count = await User.countDocuments()
  const { name, email, password, role, permissions } = req.body || {}
  if (!name?.trim() || !email?.trim() || !password) {
    const error = new Error('Name, email and password are required.')
    error.status = 400
    throw error
  }
  if (String(password).length < 12) {
    const error = new Error('Password must be at least 12 characters long.')
    error.status = 400
    throw error
  }
  if (count > 0) {
    const error = new Error('Use an admin account to create additional users.')
    error.status = 403
    throw error
  }
  if (role != null && !['admin', 'staff'].includes(role)) {
    const error = new Error('Role must be admin or staff.')
    error.status = 400
    throw error
  }
  const user = await User.create({
    name: name.trim(),
    email: email.trim().toLowerCase(),
    passwordHash: await bcrypt.hash(String(password), 10),
    role: 'admin',
    permissions: ALL_PERMISSIONS,
  })
  res.status(201).json({ token: signToken(user), user: publicUser(user) })
}))

authRouter.post('/login', asyncHandler(async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const escapedEmail = email.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const user = await User.findOne({ email: { $regex: `^${escapedEmail}$`, $options: 'i' } })
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
    const error = new Error('Email or password is incorrect.')
    error.status = 401
    throw error
  }
  await appendAuditEntry({ type: 'login', referenceId: String(user._id), description: `${user.name} signed in` }, user).catch((error) => console.error('Could not log sign-in:', error.message))
  res.json({ token: signToken(user), user: publicUser(user) })
}))

authRouter.get('/me', authRequired, (req, res) => {
  res.json({ user: currentUserPayload(req.user) })
})

authRouter.post('/logout', authRequired, asyncHandler(async (req, res) => {
  await appendAuditEntry({ type: 'logout', referenceId: String(req.user._id), description: `${req.user.name} signed out` }, req.user)
  res.json({ ok: true })
}))

authRouter.get('/users', authRequired, requirePermission('admin'), asyncHandler(async (_req, res) => {
  const users = await User.find().sort({ createdAt: -1 })
  res.json({ data: users.map(publicUser) })
}))

authRouter.post('/users', authRequired, requirePermission('admin'), asyncHandler(async (req, res) => {
  const { name, email, password, role, permissions } = req.body || {}
  if (!name?.trim() || !email?.trim() || !password) {
    const error = new Error('Name, email and password are required.')
    error.status = 400
    throw error
  }
  if (String(password).length < 12) {
    const error = new Error('Password must be at least 12 characters long.')
    error.status = 400
    throw error
  }
  const user = await User.create({
    name: name.trim(),
    email: email.trim().toLowerCase(),
    passwordHash: await bcrypt.hash(String(password), 10),
    role: role === 'admin' ? 'admin' : 'staff',
    permissions: normalizePermissions(role === 'admin' ? 'admin' : 'staff', {}, permissions),
  })
  await appendAuditEntry({ type: 'user-created', referenceId: String(user._id), description: `User ${user.name} created`, details: { role: user.role, permissions: user.permissions } }, req.user).catch((error) => console.error('Could not log user creation:', error.message))
  res.status(201).json({ data: publicUser(user) })
}))

authRouter.patch('/users/:id', authRequired, requirePermission('admin'), asyncHandler(async (req, res) => {
  const user = await User.findById(req.params.id)
  if (!user) {
    const error = new Error('User could not be found.')
    error.status = 404
    throw error
  }
  if (req.body.name) user.name = req.body.name
  const previousRole = user.role
  const previousPermissions = previousRole === 'admin' ? { ...ALL_PERMISSIONS } : { ...(user.permissions || {}) }
  if (req.body.role != null && !['admin', 'staff'].includes(req.body.role)) {
    const error = new Error('Role must be admin or staff.')
    error.status = 400
    throw error
  }
  if (req.body.role) user.role = req.body.role
  if (previousRole === 'admin' && user.role !== 'admin') {
    if (String(req.user._id) === String(user._id)) {
      const error = new Error('You cannot remove your own administrator access.')
      error.status = 400
      throw error
    }
    if (await User.countDocuments({ role: 'admin', active: true }) <= 1) {
      const error = new Error('The last active administrator cannot be demoted.')
      error.status = 400
      throw error
    }
  }
  if (previousRole === 'admin' && user.active && req.body.active === false && await User.countDocuments({ role: 'admin', active: true }) <= 1) {
    const error = new Error('The last active administrator cannot be deactivated.')
    error.status = 400
    throw error
  }
  if (req.body.active != null) user.active = Boolean(req.body.active)
  if (req.body.permissions) {
    user.permissions = normalizePermissions(user.role, previousRole === 'admin' ? {} : previousPermissions, req.body.permissions)
  } else if (previousRole === 'admin' && user.role === 'staff') {
    user.permissions = normalizePermissions('staff')
  }
  if (req.body.password && String(req.body.password).length < 12) {
    const error = new Error('Password must be at least 12 characters long.')
    error.status = 400
    throw error
  }
  if (req.body.password) user.passwordHash = await bcrypt.hash(String(req.body.password), 10)
  if (user.role === 'admin') user.permissions = ALL_PERMISSIONS
  const nextPermissions = user.role === 'admin' ? ALL_PERMISSIONS : normalizePermissions(user.role, { ...(user.permissions || {}) }, req.body.permissions || {})
  const changedPermissions = [...new Set([...Object.keys(previousPermissions), ...Object.keys(nextPermissions)])]
    .filter((key) => Boolean(previousPermissions[key]) !== Boolean(nextPermissions[key]))
  user.permissions = nextPermissions
  await user.save()
  if (changedPermissions.length || req.body.role != null) {
    await appendAuditEntry({ type: 'user-permissions-updated', referenceId: String(user._id), description: `Access updated for ${user.name}`, details: { changedPermissions, role: user.role } }, req.user).catch((error) => console.error('Could not log permission change:', error.message))
  }
  res.json({ data: publicUser(user) })
}))

authRouter.delete('/users/:id', authRequired, requirePermission('admin'), asyncHandler(async (req, res) => {
  if (String(req.user._id) === req.params.id) {
    const error = new Error('You cannot delete your own account.')
    error.status = 400
    throw error
  }

  const user = await User.findById(req.params.id)
  if (!user) {
    const error = new Error('User could not be found.')
    error.status = 404
    throw error
  }
  if (user.role === 'admin' && user.active && await User.countDocuments({ role: 'admin', active: true }) <= 1) {
    const error = new Error('The last administrator cannot be deleted.')
    error.status = 400
    throw error
  }

  await user.deleteOne()
  await appendAuditEntry({ type: 'user-deleted', referenceId: String(user._id), description: `User ${user.name} deleted`, details: { email: user.email, role: user.role } }, req.user).catch((error) => console.error('Could not log user deletion:', error.message))
  res.status(204).end()
}))
