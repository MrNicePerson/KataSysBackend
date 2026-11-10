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
  if (name === 'bankTransactions') schema.index({ date: -1, accountId: 1 })
  if (name === 'bankBalanceRecords') schema.index({ accountId: 1, date: -1, revision: -1 })
  if (name === 'cheques') schema.index({ expectedClearanceDate: 1, status: 1, direction: 1 })
  return mongoose.models[name] || mongoose.model(name, schema, name)
}

export const ARRAY_COLLECTIONS = [
  'products',
  'tanTypes',
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
  'stockAudits',
  'dailyClosings',
  'auditHistory',
  'financeEntries',
  'installments',
  'bankAccounts',
  'bankTransactions',
  'bankBalanceRecords',
]

export const OBJECT_KEYS = ['settings', 'business', 'counters']

export const collectionModels = Object.fromEntries(ARRAY_COLLECTIONS.map((name) => [name, modelFor(name)]))
export const Meta = mongoose.models.Meta || mongoose.model('Meta', new mongoose.Schema({
  id: { type: String, required: true, unique: true },
  value: { type: mongoose.Schema.Types.Mixed, default: {} },
}, { strict: false, versionKey: false }), 'meta')

const notificationSchema = new mongoose.Schema({
  eventKey: { type: String, required: true },
  recipientId: { type: String, required: true },
  actorId: { type: String, required: true },
  actorName: { type: String, default: '' },
  title: { type: String, required: true },
  message: { type: String, required: true },
  category: { type: String, enum: ['sales', 'stock', 'payments', 'cheques', 'warnings', 'activity'], required: true },
  priority: { type: String, enum: ['normal', 'important', 'urgent'], default: 'normal' },
  permission: { type: String, required: true },
  state: { type: String, default: '' },
  relatedType: { type: String, default: '' },
  relatedId: { type: String, default: '' },
  createdAt: { type: Date, default: Date.now },
  scheduledAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: Date.now },
  readAt: { type: Date, default: null },
  archivedAt: { type: Date, default: null },
}, { timestamps: false, versionKey: false })
notificationSchema.index({ recipientId: 1, createdAt: -1 })
notificationSchema.index({ recipientId: 1, deliveredAt: 1, scheduledAt: 1 })
notificationSchema.index({ recipientId: 1, eventKey: 1 }, { unique: true })
notificationSchema.index({ relatedType: 1, relatedId: 1, recipientId: 1, createdAt: -1 })

export const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema, 'notifications')
