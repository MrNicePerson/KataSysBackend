import { createEmptyDatabase, runDatabaseCommand } from '../domain/businessLogic.js'
import { ARRAY_COLLECTIONS, OBJECT_KEYS, Meta, collectionModels } from '../models/documents.js'

let cache = null
let queue = Promise.resolve()
const RECOVERY_JOURNAL_ID = 'pending-bulk-recovery'
const RECOVERY_COLLECTIONS = ['customers', 'payments', 'auditHistory']

function stripMongo(doc) {
  if (!doc) return doc
  const row = { ...doc }
  delete row._id
  delete row.__v
  return row
}

async function replaceCollection(name, rows) {
  const Model = collectionModels[name]
  await Model.deleteMany({})
  if (rows?.length) await Model.insertMany(rows, { ordered: false })
}

async function recoverPendingRecovery() {
  const pending = await Meta.findOne({ id: RECOVERY_JOURNAL_ID }).lean()
  if (!pending) return
  for (const name of RECOVERY_COLLECTIONS) await replaceCollection(name, pending.value[name])
  await Meta.deleteOne({ id: RECOVERY_JOURNAL_ID })
  cache = null
}

export async function loadSnapshot() {
  await recoverPendingRecovery()
  await collectionModels.purchases.init()
  const empty = createEmptyDatabase()
  const snapshot = { ...empty }
  await Promise.all(ARRAY_COLLECTIONS.map(async (name) => {
    const rows = await collectionModels[name].find({}).lean()
    snapshot[name] = rows.map(stripMongo)
  }))
  const meta = await Meta.find({ id: { $in: OBJECT_KEYS } }).lean()
  for (const item of meta) snapshot[item.id] = item.value || empty[item.id]
  snapshot.version = empty.version
  cache = snapshot
  return snapshot
}

export async function getSnapshot() {
  if (!cache) await loadSnapshot()
  return cache
}

async function persistSnapshot(snapshot) {
  // Validate before this legacy snapshot writer replaces any collections.
  const batches = new Set()
  for (const purchase of snapshot.purchases || []) {
    if (!purchase.batchNumber) continue
    if (batches.has(purchase.batchNumber)) throw new Error('This receiving Batch Number already exists.')
    batches.add(purchase.batchNumber)
  }
  await Promise.all(ARRAY_COLLECTIONS.map(async (name) => {
    const Model = collectionModels[name]
    await Model.deleteMany({})
    if (snapshot[name]?.length) await Model.insertMany(snapshot[name], { ordered: false })
  }))
  await Promise.all(OBJECT_KEYS.map((key) => Meta.replaceOne(
    { id: key },
    { id: key, value: snapshot[key] || {} },
    { upsert: true },
  )))
  cache = snapshot
}

async function persistBulkRecovery(current, next) {
  const before = Object.fromEntries(RECOVERY_COLLECTIONS.map((name) => [name, current[name]]))
  await Meta.create({ id: RECOVERY_JOURNAL_ID, value: before })
  try {
    for (const name of RECOVERY_COLLECTIONS) await replaceCollection(name, next[name])
    await Meta.deleteOne({ id: RECOVERY_JOURNAL_ID })
    cache = next
  } catch (error) {
    cache = null
    try {
      await recoverPendingRecovery()
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Recovery save failed; the pending journal will restore the previous balances on the next load.')
    }
    throw error
  }
}

export function withLock(work) {
  const run = queue.then(work, work)
  queue = run.then(() => undefined, () => undefined)
  return run
}

function describeAuditType(type, description = '') {
  const value = `${type} ${description}`.toLowerCase()
  const module = value.includes('sale') ? 'Sales'
    : value.includes('purchase') || value.includes('receiv') ? 'Purchases'
      : value.includes('stock') || value.includes('product') ? 'Stock'
        : value.includes('supplier') ? 'Suppliers'
          : value.includes('customer') || value.includes('return') ? 'Customers / Returns'
            : value.includes('cheque') ? 'Cheques'
              : value.includes('daily') || value.includes('closing') ? 'Daily Open & Closing'
                : value.includes('bank') || value.includes('finance') || value.includes('payment') || value.includes('expense') ? 'Payments & Finance'
                  : value.includes('user') || value.includes('permission') ? 'Users & Permissions'
                    : value.includes('setting') ? 'Settings'
                      : value.includes('notification') ? 'Notifications'
                        : 'General'
  const action = /delet|remov|discard|cancel/.test(value) ? 'Deleted'
    : /updat|edit|correct|reschedul|status|mark|approv|clear|bounce/.test(value) ? 'Updated'
      : /login/.test(value) ? 'Login'
        : /logout|sign out/.test(value) ? 'Logout'
          : /creat|record|sav|receiv|held|added|created/.test(value) ? 'Created'
            : 'Activity'
  return { module, action }
}

export async function runCommand(command, input = {}, actor = null) {
  return withLock(async () => {
    const current = await getSnapshot()
    const result = runDatabaseCommand(current, command, input, { actor })
    if (actor && command !== 'restore-backup') {
      const previousIds = new Set((current.auditHistory || []).map((entry) => entry.id))
      result.database.auditHistory = result.database.auditHistory.map((entry) => {
        if (previousIds.has(entry.id) || entry.userId) return entry
        const { module, action } = describeAuditType(entry.type, entry.description)
        return { ...entry, module, action, userId: String(actor._id || actor.id || ''), userName: actor.name || '' }
      })
    }
    if (command === 'bulk-recovery') await persistBulkRecovery(current, result.database)
    else await persistSnapshot(result.database)
    return result.record
  })
}

export async function appendAuditEntry({ type, referenceId = '', description, details = null }, actor = null) {
  return withLock(async () => {
    const current = await getSnapshot()
    const { module, action } = describeAuditType(type, description)
    const id = `audit-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
    const entry = {
      id,
      type,
      module,
      action,
      referenceId,
      description,
      details,
      date: new Date().toISOString(),
      userId: String(actor?._id || actor?.id || ''),
      userName: actor?.name || '',
    }
    await collectionModels.auditHistory.create(entry)
    cache = { ...current, auditHistory: [...(current.auditHistory || []), entry] }
    return entry
  })
}

export async function replaceSnapshot(snapshot) {
  return withLock(async () => {
    await persistSnapshot(snapshot)
    return snapshot
  })
}
