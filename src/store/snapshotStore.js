import mongoose from 'mongoose'
import { createEmptyDatabase, runDatabaseCommand } from '../domain/businessLogic.js'
import { ARRAY_COLLECTIONS, OBJECT_KEYS, Meta, collectionModels } from '../models/documents.js'

let cache = null
let queue = Promise.resolve()
const SNAPSHOT_JOURNAL_ID = 'pending-snapshot-save'
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
  const pendingSnapshot = await Meta.findOne({ id: SNAPSHOT_JOURNAL_ID }).lean()
  if (pendingSnapshot) {
    await persistSnapshot(pendingSnapshot.value)
    await Meta.deleteOne({ id: SNAPSHOT_JOURNAL_ID })
  }
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
  if (reconcileReceivedStock(snapshot)) {
    await Meta.create({ id: SNAPSHOT_JOURNAL_ID, value: snapshot })
    try {
      await persistSnapshot(snapshot)
      await Meta.deleteOne({ id: SNAPSHOT_JOURNAL_ID })
    } catch (error) {
      cache = null
      throw error
    }
  }
  cache = snapshot
  return snapshot
}

function reconcileReceivedStock(snapshot) {
  let changed = false
  for (const purchase of snapshot.purchases || []) {
    for (const [index, item] of (purchase.items || []).entries()) {
      if (item.productId && snapshot.products.some((product) => product.id === item.productId)) continue
      const itemCode = String(item.code || item.articleNumber || '').trim().toLowerCase()
      const itemName = String(item.productName || item.name || '').trim().toLowerCase()
      const itemBatch = String(item.batchNumber || purchase.batchNumber || '').trim().toLowerCase()
      const candidates = snapshot.products.filter((product) => {
        if (product.purchaseId !== purchase.id || String(product.batchNumber || '').trim().toLowerCase() !== itemBatch) return false
        const productCode = String(product.code || product.articleNumber || '').trim().toLowerCase()
        const productName = String(product.name || product.productName || '').trim().toLowerCase()
        return (!itemCode || productCode === itemCode) && (!itemName || productName === itemName)
      })
      if (candidates.length === 1) {
        item.productId = candidates[0].id
        changed = true
        continue
      }
      if (candidates.length > 1 || !(Number(item.quantity) > 0)) continue
      const product = {
        id: `product-recovered-${purchase.id}-${item.lineId || index}`,
        name: String(item.productName || item.name || item.code || item.articleNumber || 'Recovered received item'),
        code: String(item.code || item.articleNumber || `recovered-${purchase.id}-${index}`),
        article: String(item.code || item.articleNumber || ''),
        articleNumber: String(item.code || item.articleNumber || ''),
        brandName: String(item.brandName || ''),
        supplierId: purchase.supplierId,
        supplier: purchase.supplier,
        batchNumber: item.batchNumber || purchase.batchNumber || '',
        purchaseId: purchase.id,
        purchaseItemId: item.lineId || '',
        arrivalDate: purchase.date,
        season: item.season || '',
        size: item.size || '',
        rackLocation: item.rackLocation || '',
        productType: item.productType === 'tan' ? 'tan' : 'suit',
        stockQuantity: Number(item.quantity || 0),
        reservedQuantity: 0,
        defectiveQuantity: 0,
        averageCost: Number(item.unitCost || 0),
        salePrice: Number(item.salePrice || 0),
        active: true,
      }
      if (product.productType === 'tan') Object.assign(product, {
        tanType: item.tanType || '', metersPerTan: Number(item.metersPerTan || 0),
        buyPricePerMeter: Number(item.buyPricePerMeter || 0), salePricePerMeter: Number(item.salePricePerMeter || 0),
      })
      snapshot.products.push(product)
      item.productId = product.id
      snapshot.stockMovements.push({
        id: `move-recovered-${purchase.id}-${item.lineId || index}`, productId: product.id,
        type: 'purchase', quantity: product.stockQuantity, referenceId: purchase.id,
        date: purchase.date, note: product.batchNumber,
      })
      changed = true
    }
  }
  return changed
}

export async function getSnapshot() {
  if (!cache) await loadSnapshot()
  return cache
}

function validateSnapshot(snapshot) {
  const batches = new Set()
  for (const purchase of snapshot.purchases || []) {
    if (!purchase.batchNumber) continue
    if (batches.has(purchase.batchNumber)) throw new Error('This receiving Batch Number already exists.')
    batches.add(purchase.batchNumber)
  }
}

async function persistSnapshot(snapshot, session = null) {
  validateSnapshot(snapshot)
  const persistCollection = async (name) => {
    const Model = collectionModels[name]
    await Model.deleteMany({}, session ? { session } : {})
    if (snapshot[name]?.length) await Model.insertMany(snapshot[name], { ordered: false, ...(session ? { session } : {}) })
  }
  if (session) {
    for (const name of ARRAY_COLLECTIONS) await persistCollection(name)
    for (const key of OBJECT_KEYS) await Meta.replaceOne(
      { id: key },
      { id: key, value: snapshot[key] || {} },
      { upsert: true, session },
    )
  } else {
    for (const name of ARRAY_COLLECTIONS) await persistCollection(name)
    for (const key of OBJECT_KEYS) await Meta.replaceOne(
      { id: key },
      { id: key, value: snapshot[key] || {} },
      { upsert: true },
    )
  }
  if (!session) cache = snapshot
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
    const current = await loadSnapshot()
    const result = runDatabaseCommand(current, command, input, { actor })
    if (actor && command !== 'restore-backup') {
      const previousIds = new Set((current.auditHistory || []).map((entry) => entry.id))
      result.database.auditHistory = result.database.auditHistory.map((entry) => {
        if (previousIds.has(entry.id) || entry.userId) return entry
        const { module, action } = describeAuditType(entry.type, entry.description)
        return { ...entry, module, action, userId: String(actor._id || actor.id || ''), userName: actor.name || '' }
      })
    }
    if (command === 'bulk-recovery') {
      await persistBulkRecovery(current, result.database)
    } else {
      const topologyType = mongoose.connection.getClient()?.topology?.description?.type
      if (topologyType === 'ReplicaSetWithPrimary' || topologyType === 'Sharded') {
        const session = await mongoose.startSession()
        try {
          await session.withTransaction(async () => {
            await persistSnapshot(result.database, session)
          })
          cache = result.database
        } catch (error) {
          cache = null
          throw error
        } finally {
          await session.endSession()
        }
      } else {
        await Meta.create({ id: SNAPSHOT_JOURNAL_ID, value: current })
        try {
          await persistSnapshot(result.database)
          await Meta.deleteOne({ id: SNAPSHOT_JOURNAL_ID })
        } catch (error) {
          cache = null
          await loadSnapshot()
          throw error
        }
      }
    }
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
