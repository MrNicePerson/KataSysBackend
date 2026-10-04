import mongoose from 'mongoose'

const documentSchema = new mongoose.Schema({
  id: { type: String, required: true, unique: true, index: true },
}, { strict: false, versionKey: false })

function modelFor(name) {
  const schema = documentSchema.clone()
  if (name === 'purchases') {
    schema.add({ batchNumber: { type: String, trim: true }, supplierBillNumber: { type: Number, min: 1 } })
    // Legacy purchases without a bill-level batch remain valid.
    schema.index({ batchNumber: 1 }, { unique: true, partialFilterExpression: { batchNumber: { $type: 'string' } } })
  }
  if (name === 'products') schema.add({ batchNumber: String, purchaseId: String })
  if (name === 'supplierReturns') schema.add({ batchNumber: String })
  return mongoose.models[name] || mongoose.model(name, schema, name)
}

export const ARRAY_COLLECTIONS = [
  'products',
  'categories',
  'customers',
  'suppliers',
  'sales',
  'purchases',
  'returns',
  'supplierReturns',
  'payments',
  'cheques',
  'expenses',
  'heldOrders',
  'claims',
  'stockMovements',
  'dailyClosings',
  'auditHistory',
  'financeEntries',
  'installments',
]

export const OBJECT_KEYS = ['settings', 'business', 'counters']

export const collectionModels = Object.fromEntries(ARRAY_COLLECTIONS.map((name) => [name, modelFor(name)]))
export const Meta = mongoose.models.Meta || mongoose.model('Meta', new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { strict: false, versionKey: false }), 'meta')
