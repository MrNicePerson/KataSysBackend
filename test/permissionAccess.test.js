import assert from 'node:assert/strict'
import test from 'node:test'
import { hasAnyModulePermission, hasPermission, normalizePermissions } from '../src/models/User.js'

test('legacy finance permission preserves daily closing view access', () => {
  const user = { role: 'staff', permissions: { finance: true } }
  assert.equal(hasPermission(user, 'dailyClosing', 'view'), true)
  assert.equal(hasPermission(user, 'dailyClosing', 'dailyClosingCreate'), true)
})

test('explicit granular permission overrides a legacy module grant', () => {
  const user = { role: 'staff', permissions: { finance: true, dailyClosingView: false, dailyOpeningCreate: true } }
  assert.equal(hasPermission(user, 'dailyClosing', 'view'), false)
  assert.equal(hasPermission(user, 'dailyClosing', 'dailyOpeningCreate'), false)
})

test('a denied action does not fall through to the legacy module grant', () => {
  const permissions = normalizePermissions('staff', { sales: true }, { salesDelete: false })
  assert.equal(hasPermission({ role: 'staff', permissions }, 'sales', 'delete'), false)
})

test('module actions can be granted independently without delete access', () => {
  const user = { role: 'staff', permissions: { sales: true, salesView: true, salesCreate: true, salesEdit: false, salesDelete: false } }
  assert.equal(hasPermission(user, 'sales', 'create'), true)
  assert.equal(hasPermission(user, 'sales', 'edit'), false)
  assert.equal(hasPermission(user, 'sales', 'delete'), false)
  assert.equal(hasAnyModulePermission(user, 'sales'), true)
})

test('staff normalization cannot grant admin and derives legacy daily closing access', () => {
  const permissions = normalizePermissions('staff', { finance: true }, { admin: true })
  assert.equal(permissions.admin, false)
  assert.equal(permissions.dailyClosing, true)
  assert.equal(hasPermission({ role: 'staff', permissions }, 'dailyClosing', 'view'), true)
})

test('administrators retain full module access regardless of granular flags', () => {
  assert.equal(hasPermission({ role: 'admin', permissions: { salesDelete: false } }, 'sales', 'delete'), true)
})
