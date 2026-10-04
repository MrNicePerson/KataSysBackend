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

export async function runCommand(command, input = {}) {
  return withLock(async () => {
    const current = await getSnapshot()
    const result = runDatabaseCommand(current, command, input)
    if (command === 'bulk-recovery') await persistBulkRecovery(current, result.database)
    else await persistSnapshot(result.database)
    return result.record
  })
}

export async function replaceSnapshot(snapshot) {
  return withLock(async () => {
    await persistSnapshot(snapshot)
    return snapshot
  })
}
