import { Notification } from '../models/documents.js'
import { hasPermission, User } from '../models/User.js'
import { getSnapshot } from '../store/snapshotStore.js'

const events = {
  'create-sale': (record) => ({ title: `Sale ${record.number} recorded`, message: `${record.customer || 'Walk-in customer'} · Rs. ${Number(record.total || 0).toLocaleString()}`, category: 'sales', permission: 'sales', relatedType: 'sale', relatedId: record.id }),
  'receive-purchase': (record) => ({ title: 'New stock received', message: `${record.supplier || 'Supplier'} · ${record.batchNumber || 'Purchase'} · Rs. ${Number(record.total || 0).toLocaleString()}`, category: 'stock', permission: 'stock', relatedType: 'purchase', relatedId: record.id }),
  'customer-return': (record) => ({ title: 'Customer return processed', message: `${record.itemName || 'Item'} · ${record.quantity} returned`, category: 'sales', permission: 'returns', relatedType: 'return', relatedId: record.id }),
  'supplier-return': (record) => ({ title: 'Supplier return processed', message: `${record.itemName || 'Item'} · ${record.quantity} returned`, category: 'stock', permission: 'stock', relatedType: 'supplier-return', relatedId: record.id }),
  'account-payment': (record) => ({ title: `${record.type === 'supplier-payment' ? 'Supplier' : 'Customer'} payment recorded`, message: `Rs. ${Number(record.amount || 0).toLocaleString()} · ${record.method || 'cash'}`, category: 'payments', permission: record.type === 'supplier-payment' ? 'suppliers' : 'customers', relatedType: record.accountType === 'supplier' ? 'supplier-payment' : 'payment', relatedId: record.id }),
  'cheque-status': (record) => ({ title: `Cheque ${record.status.toLowerCase()}`, message: `${record.number || record.id} · Rs. ${Number(record.amount || 0).toLocaleString()}`, category: 'cheques', permission: 'cheques', relatedType: 'cheque', relatedId: record.id, priority: ['Bounced', 'Returned'].includes(record.status) ? 'urgent' : 'important' }),
  'create-cheque': (record) => ({ title: 'Cheque recorded', message: `${record.number || record.id} · Rs. ${Number(record.amount || 0).toLocaleString()}`, category: 'cheques', permission: 'cheques', relatedType: 'cheque', relatedId: record.id }),
  'create-product': (record) => ({ title: 'Product added to stock', message: `${record.name || record.code || 'New product'} · ${Number(record.stockQuantity || 0)} units`, category: 'stock', permission: 'stock', relatedType: 'product', relatedId: record.id }),
  'update-product': (record) => ({ title: 'Product details updated', message: `${record.name || record.code || 'Stock item'} was updated.`, category: 'stock', permission: 'stock', relatedType: 'product', relatedId: record.id }),
  'adjust-stock': (record) => ({ title: 'Stock quantity updated', message: `${record.quantity > 0 ? '+' : ''}${record.quantity} units · ${record.reason || 'Stock adjustment'}`, category: 'stock', permission: 'stock', relatedType: 'stock-adjustment', relatedId: record.id }),
  'stock-audit': (record) => ({ title: 'Stock count recorded', message: 'A stock audit has been completed.', category: 'stock', permission: 'stock', relatedType: 'stock-audit', relatedId: record.id }),
  'create-claim': (record) => ({ title: 'Stock claim recorded', message: `${record.description || record.reason || 'Defect claim'} · ${record.quantity || 0} units`, category: 'stock', permission: 'stock', relatedType: 'claim', relatedId: record.id }),
  'claim-status': (record) => ({ title: `Stock claim ${String(record.status || '').toLowerCase()}`, message: record.description || 'A stock claim status changed.', category: 'stock', permission: 'stock', relatedType: 'claim', relatedId: record.id }),
  'claim-update': (record) => ({ title: 'Stock claim updated', message: record.description || 'Claim details were updated.', category: 'stock', permission: 'stock', relatedType: 'claim', relatedId: record.id }),
  'expense': (record) => ({ title: 'Business expense recorded', message: `${record.description || record.category} · Rs. ${Number(record.amount || 0).toLocaleString()}`, category: 'payments', permission: 'finance', relatedType: 'expense', relatedId: record.id }),
  'daily-record': (record) => ({ title: `Daily ${record.type} recorded`, message: `${record.date} · Rs. ${Number(record.amount || 0).toLocaleString()}`, category: 'activity', permission: 'finance', relatedType: 'daily-closing', relatedId: record.id }),
  'delete-daily-record': (record) => ({ title: 'Daily record deleted', message: `Daily ${record.type} for ${record.date} was deleted.`, category: 'warnings', permission: 'finance', relatedType: 'daily-closing', relatedId: record.id, priority: 'important' }),
  'finance': (record) => ({ title: 'Financial entry recorded', message: `${record.description || record.type || 'Entry'} · Rs. ${Number(record.amount || 0).toLocaleString()}`, category: 'payments', permission: 'finance', relatedType: 'finance-entry', relatedId: record.id }),
  'update-sale-bill': (record) => ({ title: `Sale ${record.number || ''} updated`.trim(), message: `${record.customer || 'Customer'} · Rs. ${Number(record.total || 0).toLocaleString()}`, category: 'sales', permission: 'sales', relatedType: 'sale', relatedId: record.id }),
  'update-sale-receipt': (record) => ({ title: `Receipt ${record.number || ''} updated`.trim(), message: record.customer || 'Sale receipt details changed.', category: 'sales', permission: 'sales', relatedType: 'sale', relatedId: record.id }),
  'update-account': (record) => ({ title: `${record.type || 'Account'} details updated`, message: record.name || 'Account details were changed.', category: 'activity', permission: record.type === 'supplier' ? 'suppliers' : 'customers', relatedType: record.type || 'customer', relatedId: record.id }),
  'hold-order': (record) => ({ title: 'Order saved', message: `${record.customer || 'Customer'} · ${record.items?.length || 0} items`, category: 'sales', permission: 'orders', relatedType: 'order', relatedId: record.id }),
  'release-held-order': (record) => ({ title: 'Held order resumed', message: `${record.customer || 'Customer'} · ${record.id}`, category: 'activity', permission: 'orders', relatedType: 'order', relatedId: record.id }),
  'discard-held-order': (record) => ({ title: 'Held order cancelled', message: `${record.customer || 'Customer'} · ${record.id}`, category: 'warnings', permission: 'orders', relatedType: 'order', relatedId: record.id }),
  'create-installment': (record) => ({ title: 'Payment plan created', message: `${record.customer || 'Customer'} · Rs. ${Number(record.total || record.amount || 0).toLocaleString()}`, category: 'payments', permission: 'customers', relatedType: 'payment', relatedId: record.id }),
  'installment-payment': (record) => ({ title: 'Installment payment received', message: `Rs. ${Number(record.amount || 0).toLocaleString()}`, category: 'payments', permission: 'customers', relatedType: 'payment', relatedId: record.id }),
  'save-settings': (record) => ({ title: 'Business settings updated', message: 'Workspace settings were changed.', category: 'activity', permission: 'settings', relatedType: 'settings', relatedId: 'shop' }),
  'create-bank-account': (record) => ({ title: 'Bank account added', message: `${record.name} · opening balance Rs. ${Number(record.openingBalance || 0).toLocaleString()}`, category: 'activity', permission: 'finance', relatedType: 'bank-account', relatedId: record.id }),
  'bank-transaction': (record) => ({ title: `${record.type === 'withdrawal' ? 'Bank withdrawal' : record.type === 'transfer' ? 'Bank transfer' : 'Cash deposit'} recorded`, message: `Rs. ${Number(record.amount || 0).toLocaleString()} · ${record.date}${record.reference ? ` · ${record.reference}` : ''}`, category: 'payments', permission: 'finance', relatedType: 'bank-transaction', relatedId: record.id }),
  'cheque-details': (record) => ({ title: 'Cheque details updated', message: `${record.number || record.id} · due ${record.expectedClearanceDate || 'date not set'}`, category: 'cheques', permission: 'cheques', relatedType: 'cheque', relatedId: record.id }),
}

export function describeActivity(command, record) {
  return events[command]?.(record) || null
}

export function stockLevelState(quantity, threshold) {
  if (quantity <= 0) return 'out'
  if (quantity <= threshold) return 'low'
  return 'normal'
}

export async function createStockLevelNotifications(command, record, actor) {
  const stockCommands = new Set(['create-sale', 'receive-purchase', 'customer-return', 'supplier-return', 'adjust-stock', 'stock-audit', 'update-product'])
  if (!stockCommands.has(command) || !actor?._id) return
  const database = await getSnapshot()
  const productIds = command === 'stock-audit'
    ? new Set(database.products.map((product) => product.id))
    : new Set([record.productId, ...(record.items || []).map((item) => item.productId)].filter(Boolean))
  if (!productIds.size) return
  const products = database.products.filter((product) => productIds.has(product.id))
  const users = await User.find({ active: true }).select('_id name role permissions notificationPreferences').lean()
  const notifications = []
  const actorId = String(actor._id)
  const threshold = Math.max(0, Number(database.settings?.stockThreshold ?? 10))
  for (const product of products) {
    const quantity = Math.max(0, Number(product.stockQuantity || 0) - Number(product.reservedQuantity || 0))
    const state = stockLevelState(quantity, threshold)
    const previous = await Notification.find({ relatedType: 'stock-level', relatedId: product.id, archivedAt: null }).sort({ createdAt: -1 }).lean()
    if (state === 'normal') {
      if (previous.length) await Notification.updateMany({ _id: { $in: previous.map(({ _id }) => _id) } }, { $set: { archivedAt: new Date() } })
      continue
    }
    const stale = previous.filter((notification) => notification.state !== state)
    if (stale.length) await Notification.updateMany({ _id: { $in: stale.map(({ _id }) => _id) } }, { $set: { archivedAt: new Date() } })
    const isOut = state === 'out'
    for (const user of users) {
      const recipientId = String(user._id)
      const permitted = user.role === 'admin' || user.permissions?.admin || user.permissions?.stock
      if (!hasPermission(user, 'notifications', 'view') || user.notificationPreferences?.stock === false || !(recipientId === actorId || permitted)) continue
      const sameState = previous.find((notification) => notification.recipientId === recipientId && notification.state === state)
      if (sameState) continue
      notifications.push({
        eventKey: `${command}:${record.id}:stock:${product.id}:${state}`,
        recipientId,
        actorId,
        actorName: actor.name || '',
        title: isOut ? `${product.name} is out of stock` : `${product.name} is running low`,
        message: isOut ? 'No available stock remains.' : `${quantity} units remain; threshold is ${threshold}.`,
        category: isOut ? 'warnings' : 'stock',
        priority: isOut ? 'urgent' : 'important',
        permission: 'stock',
        state,
        relatedType: 'stock-level',
        relatedId: product.id,
        createdAt: new Date(),
        deliveredAt: new Date(),
      })
    }
  }
  if (notifications.length) await Notification.bulkWrite(notifications.map((notification) => ({
    updateOne: {
      filter: { recipientId: notification.recipientId, eventKey: notification.eventKey },
      update: { $setOnInsert: notification },
      upsert: true,
    },
  })), { ordered: false })
}

export async function createActivityNotifications(command, record, actor) {
  if (command === 'save-bank-balances' && Array.isArray(record)) {
    const users = await User.find({ active: true }).select('_id name role permissions').lean()
    const accountIds = record.map((balance) => balance.accountId)
    if (accountIds.length) await Notification.updateMany({ relatedType: 'bank-account', relatedId: { $in: accountIds }, category: 'warnings', archivedAt: null }, { $set: { archivedAt: new Date() } })
    const discrepancies = record.filter((balance) => Math.abs(Number(balance.difference || 0)) >= 0.01)
    const deliveries = discrepancies.flatMap((balance) => users
      .filter((user) => hasPermission(user, 'notifications', 'view') && (user.role === 'admin' || user.permissions?.admin || user.permissions?.finance))
      .map((user) => ({
        eventKey: `bank-balance-difference:${balance.id}`,
        recipientId: String(user._id),
        actorId: String(actor?._id || ''),
        actorName: actor?.name || '',
        title: `Balance difference · ${balance.accountName}`,
        message: `${balance.date}: actual balance differs by Rs. ${Number(balance.difference).toLocaleString()}.${balance.note ? ` ${balance.note}` : ''}`,
        category: 'warnings',
        priority: 'important',
        permission: 'finance',
        relatedType: 'bank-account',
        relatedId: balance.accountId,
        createdAt: new Date(),
        deliveredAt: new Date(),
      })))
    if (deliveries.length) await Notification.bulkWrite(deliveries.map((notification) => ({
      updateOne: { filter: { recipientId: notification.recipientId, eventKey: notification.eventKey }, update: { $setOnInsert: notification }, upsert: true },
    })), { ordered: false })
    return
  }
  const event = describeActivity(command, record)
  if (!event || !record?.id || !actor?._id) return
  const users = await User.find({ active: true }).select('_id name role permissions notificationPreferences').lean()
  const actorId = String(actor._id)
  const deliveries = users.filter((user) => {
    const recipientId = String(user._id)
    const permitted = user.role === 'admin' || user.permissions?.admin || user.permissions?.[event.permission]
    const notificationsEnabled = hasPermission(user, 'notifications', 'view')
    const enabled = event.category === 'cheques' || event.category === 'warnings' || user.notificationPreferences?.[event.category] !== false
    return notificationsEnabled && enabled && (recipientId === actorId || permitted)
  }).map((user) => ({
    eventKey: `${command}:${record.id}`,
    recipientId: String(user._id),
    actorId,
    actorName: actor.name || '',
    ...event,
    createdAt: new Date(),
    deliveredAt: new Date(),
  }))
  if (!deliveries.length) return
  await Notification.bulkWrite(deliveries.map((notification) => ({
    updateOne: {
      filter: { recipientId: notification.recipientId, eventKey: notification.eventKey },
      update: { $setOnInsert: notification },
      upsert: true,
    },
  })), { ordered: false })
  if (command === 'create-cheque') await scheduleChequeReminders(record)
  if (command === 'cheque-details') {
    await Notification.updateMany({ relatedType: 'cheque-reminder', relatedId: record.id, deliveredAt: null, archivedAt: null }, { $set: { archivedAt: new Date() } })
    if (['Pending', 'Deposited / Presented', 'Under Clearing', 'Rescheduled'].includes(record.status)) await scheduleChequeReminders(record)
  }
  if (command === 'cheque-status' && !['Pending', 'Deposited / Presented', 'Under Clearing', 'Rescheduled'].includes(record.status)) {
    const updatedAt = new Date()
    await Notification.updateMany({ relatedType: 'cheque-reminder', relatedId: record.id, deliveredAt: null, archivedAt: null }, { $set: { archivedAt: updatedAt } })
    await Notification.updateMany({ relatedType: 'cheque-reminder', relatedId: record.id, deliveredAt: { $ne: null }, archivedAt: null }, {
      $set: {
        title: `Cheque ${record.status.toLowerCase()}`,
        message: `Cheque ${record.number || record.id} worth Rs. ${Number(record.amount || 0).toLocaleString()} was marked ${record.status.toLowerCase()}.`,
      },
    })
  }
}

async function scheduleChequeReminders(cheque, knownUsers = null) {
  const dueDate = cheque.expectedClearanceDate || cheque.dueDate
  if (!dueDate || !['Pending', 'Deposited / Presented', 'Under Clearing', 'Rescheduled'].includes(cheque.status)) return
  const dateKey = String(dueDate).slice(0, 10)
  const midnight = new Date(`${dateKey}T00:00:00.000Z`)
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.BUSINESS_TIMEZONE || 'Asia/Karachi', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(midnight).reduce((result, part) => ({ ...result, [part.type]: part.value }), {})
  const represented = Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day), Number(parts.hour), Number(parts.minute), Number(parts.second))
  const baseDate = new Date(midnight.getTime() - (represented - midnight.getTime()))
  if (Number.isNaN(baseDate.getTime())) return
  const stages = [
    { key: 'tomorrow', offset: -1, title: 'Cheque due tomorrow', priority: 'important' },
    { key: 'due', offset: 0, title: 'Cheque due today', priority: 'urgent' },
  ]
  const users = knownUsers || await User.find({ active: true }).select('_id name role permissions').lean()
  const notifications = []
  for (const stage of stages) {
    const scheduledAt = new Date(baseDate)
    scheduledAt.setUTCDate(scheduledAt.getUTCDate() + stage.offset)
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.BUSINESS_TIMEZONE || 'Asia/Karachi' }).format(new Date())
    const stageDate = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.BUSINESS_TIMEZONE || 'Asia/Karachi' }).format(scheduledAt)
    if (stageDate < today) continue
    for (const user of users) {
      if (!hasPermission(user, 'notifications', 'view') || user.role !== 'admin' && !user.permissions?.admin && !user.permissions?.cheques) continue
      notifications.push({
        eventKey: `cheque:${cheque.id}:${dateKey}:${stage.key}`,
        recipientId: String(user._id),
        actorId: 'system',
        actorName: 'KataSys',
        title: stage.title,
        message: `Cheque ${cheque.number || cheque.id} worth Rs. ${Number(cheque.amount || 0).toLocaleString()} is ${stage.key === 'tomorrow' ? 'due tomorrow' : 'due today'}.`,
        category: 'cheques',
        priority: stage.priority,
        permission: 'cheques',
        relatedType: 'cheque-reminder',
        relatedId: cheque.id,
        createdAt: new Date(),
        scheduledAt,
        deliveredAt: null,
      })
    }
  }
  if (notifications.length) await Notification.bulkWrite(notifications.map((notification) => ({
    updateOne: {
      filter: { recipientId: notification.recipientId, eventKey: notification.eventKey },
      update: { $setOnInsert: notification },
      upsert: true,
    },
  })), { ordered: false })
}

export async function deliverDueNotifications(now = new Date()) {
  const database = await getSnapshot()
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: process.env.BUSINESS_TIMEZONE || 'Asia/Karachi' }).format(now)
  const users = await User.find({ active: true }).select('_id role permissions').lean()
  for (const cheque of database.cheques || []) {
    if (['Pending', 'Deposited / Presented', 'Under Clearing', 'Rescheduled'].includes(cheque.status)) await scheduleChequeReminders(cheque, users)
  }
  const overdue = []
  for (const cheque of database.cheques || []) {
    const dueDate = cheque.expectedClearanceDate || cheque.dueDate
    if (!['Pending', 'Deposited / Presented', 'Under Clearing', 'Rescheduled'].includes(cheque.status) || !dueDate || String(dueDate).slice(0, 10) >= today) continue
    for (const user of users) {
      if (!hasPermission(user, 'notifications', 'view') || user.role !== 'admin' && !user.permissions?.admin && !user.permissions?.cheques) continue
      overdue.push({
        eventKey: `cheque:${cheque.id}:${String(dueDate).slice(0, 10)}:overdue`,
        recipientId: String(user._id),
        actorId: 'system',
        actorName: 'KataSys',
        title: 'Cheque overdue',
        message: `Cheque ${cheque.number || cheque.id} worth Rs. ${Number(cheque.amount || 0).toLocaleString()} is overdue.`,
        category: 'warnings',
        priority: 'urgent',
        permission: 'cheques',
        relatedType: 'cheque-reminder',
        relatedId: cheque.id,
        createdAt: now,
        scheduledAt: now,
        deliveredAt: null,
      })
    }
  }
  if (overdue.length) await Notification.bulkWrite(overdue.map((notification) => ({
    updateOne: {
      filter: { recipientId: notification.recipientId, eventKey: notification.eventKey },
      update: { $setOnInsert: notification },
      upsert: true,
    },
  })), { ordered: false })
  await Notification.updateMany(
    { relatedType: 'cheque-reminder', relatedId: { $in: (database.cheques || []).filter((cheque) => !['Pending', 'Deposited / Presented', 'Under Clearing', 'Rescheduled'].includes(cheque.status)).map((cheque) => cheque.id) }, deliveredAt: null, archivedAt: null },
    { $set: { archivedAt: now } },
  )
  const due = await Notification.find({ deliveredAt: null, scheduledAt: { $lte: now }, archivedAt: null }).select('_id recipientId')
  if (!due.length) return
  await Notification.updateMany({ _id: { $in: due.map(({ _id }) => _id) }, deliveredAt: null }, { $set: { deliveredAt: now } })
}
