import { nextReceivingBatch, receivingLabel } from './receiving.js'

export const APP_DB_VERSION = 2

export function createEmptyDatabase() {
  return {
    version: APP_DB_VERSION,
    products: [],
    categories: [],
    customers: [],
    suppliers: [],
    sales: [],
    purchases: [],
    returns: [],
    supplierReturns: [],
    payments: [],
    cheques: [],
    expenses: [],
    heldOrders: [],
    claims: [],
    stockMovements: [],
    stockAudits: [],
    dailyClosings: [],
    settings: {},
    business: {},
    counters: {},
    auditHistory: [],
    financeEntries: [],
    installments: [],
    bankAccounts: [],
    bankTransactions: [],
    bankBalanceRecords: [],
  }
}

const now = () => new Date().toISOString()
export const localDateString = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
export const businessDateString = (date = new Date(), timeZone = process.env.BUSINESS_TIMEZONE || 'Asia/Karachi') => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  return `${values.year}-${values.month}-${values.day}`
}
export const DEFAULT_BRANCH_ID = 'default'
export const normalizeBranchId = (value) => String(value || DEFAULT_BRANCH_ID)
const recordMatchesBranch = (entry, branchId) => normalizeBranchId(entry?.branchId) === normalizeBranchId(branchId)
export function saleDayStatus(database, { date = businessDateString(), branchId = DEFAULT_BRANCH_ID } = {}) {
  const normalizedBranchId = normalizeBranchId(branchId)
  const records = database.dailyClosings || []
  const openingCompleted = records.some((entry) => entry.date === date && entry.type === 'opening' && recordMatchesBranch(entry, normalizedBranchId))
  const closingCompleted = records.some((entry) => entry.date === date && entry.type === 'closing' && recordMatchesBranch(entry, normalizedBranchId))
  const reason = !openingCompleted
    ? "Daily Opening is required before creating a new sale. Please complete today's opening first."
    : closingCompleted
      ? 'Daily Closing has already been completed for this business date. New sales are not allowed.'
      : ''
  return { date, branchId: normalizedBranchId, openingCompleted, closingCompleted, canCreateSale: !reason, reason }
}
export function assertSaleDayOpen(database, context = {}) {
  const status = saleDayStatus(database, context)
  if (!status.canCreateSale) throw new Error(status.reason)
  return status
}
const dateOf = (value) => value || localDateString()
const amountOf = (value) => {
  const amount = Number(value)
  if (!Number.isFinite(amount) || amount < 0) throw new Error('Amounts must be zero or greater.')
  return amount
}
const money = (value) => Math.round((Number(value) + Number.EPSILON) * 100) / 100
const positiveQuantity = (value) => {
  const quantity = Number(value)
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error('Quantity must be a positive whole number.')
  return quantity
}
const nonnegativeWholeQuantity = (value) => {
  const quantity = Number(value)
  if (!Number.isInteger(quantity) || quantity < 0) throw new Error('Stock quantity must be a non-negative whole number.')
  return quantity
}
const makeId = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`}`
const record = (prefix, values) => ({ id: makeId(prefix), createdAt: now(), ...values })
export function receivingBatchNumber(database, supplier, date) {
  return nextReceivingBatch(database, supplier, date).batchNumber
}

function addAudit(database, type, referenceId, description) {
  return [...database.auditHistory, record('audit', { type, referenceId, description, date: now() })]
}

function updateBalance(rows, id, delta) {
  if (!id) return rows
  let found = false
  const updated = rows.map((row) => {
    if (row.id !== id) return row
    found = true
    return { ...row, balance: Number(row.balance ?? row.openingBalance ?? 0) + delta }
  })
  if (!found) throw new Error('The selected account could not be found.')
  return updated
}

function getProduct(products, item) {
  let product
  if (item.productId) {
    product = products.find((entry) => entry.id === item.productId)
    if (!product) throw new Error('The selected stock item could not be found. Refresh the item list and choose it again.')
  } else {
    const code = String(item.productCode ?? item.code ?? '').trim().toLowerCase()
    const name = String(item.name ?? item.productName ?? '').trim().toLowerCase()
    const matches = code ? products.filter((entry) => entry.code?.trim().toLowerCase() === code) : products.filter((entry) => entry.name?.trim().toLowerCase() === name)
    if (matches.length > 1) throw new Error('This article exists in multiple stock batches. Select the exact batch before continuing.')
    product = matches[0]
  }
  if (!product) throw new Error(`Product “${item.name ?? item.productName ?? item.code ?? 'unknown'}” was not found in stock.`)
  if (product.active === false) throw new Error(`${product.name} is inactive and cannot be sold.`)
  return product
}

function addMovement(database, { productId, type, quantity, referenceId, date, note }) {
  return [...database.stockMovements, record('move', { productId, type, quantity, referenceId, date, note })]
}

function addPayment(database, payment) {
  return [...database.payments, record('payment', { date: dateOf(payment.date), createdAt: now(), ...payment })]
}

function validateSplits(total, payments) {
  const cash = amountOf(payments?.cash ?? 0)
  const bank = amountOf(payments?.bank ?? 0)
  const cheque = amountOf(payments?.cheque ?? 0)
  if (cash + bank > total + 0.005) throw new Error('Cash and bank payments cannot exceed the bill total.')
  if (cheque > total + 0.005) throw new Error('Cheque amount cannot exceed the bill total.')
  return { cash, bank, cheque, credit: Math.max(0, total - cash - bank) }
}

export function createSale(database, input, { actor = null } = {}) {
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('Add at least one item before saving the sale.')
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  const idempotencyFingerprint = idempotencyKey ? JSON.stringify({
    customerId: input.customerId || null,
    items: input.items.map((item) => ({
      productId: item.productId || null,
      quantity: item.quantity,
      price: item.price ?? item.unitPrice,
      isReturn: Boolean(item.isReturn || item.returnQuantity),
      returnQuantity: item.returnQuantity,
      originalSaleId: item.originalSaleId || null,
      originalSaleLineId: item.originalSaleLineId || null,
      returnCondition: item.returnCondition || '',
    })),
    discount: input.discount ?? 0,
    payments: {
      cash: input.payments?.cash ?? 0,
      bank: input.payments?.bank ?? input.payments?.bankTransfer ?? 0,
      cheque: input.payments?.cheque ?? 0,
    },
    bankDetails: input.bankDetails || null,
    cheque: input.cheque || null,
    refundType: input.refundType || 'cash',
  }) : ''
  if (idempotencyKey) {
    const existing = database.sales.find((sale) => sale.idempotencyKey === idempotencyKey)
    if (existing) {
      if (existing.idempotencyFingerprint !== idempotencyFingerprint) throw new Error('This sale submission key was already used for different transaction details.')
      return { database, record: existing }
    }
  }
  const saleInputs = input.items.filter((item) => !item.isReturn)
  const returnInputs = input.items.filter((item) => item.isReturn || item.returnQuantity)
  const saleItems = saleInputs.map((item) => {
    const quantity = positiveQuantity(item.quantity)
    const product = getProduct(database.products, item)
    const unitPrice = amountOf(item.price ?? item.unitPrice ?? product.salePrice)
    const reserved = Number(product.reservedQuantity || 0)
    if (Number(product.stockQuantity || 0) - reserved < quantity) throw new Error(`Not enough available stock for ${product.name}.`)
    return { lineId: makeId('line'), productId: product.id, code: product.code ?? '', name: product.name, quantity, price: unitPrice, unitPrice, unitCostAtSale: Number(product.averageCost || 0), lineTotal: quantity * unitPrice }
  })
  const subtotal = saleItems.reduce((sum, item) => sum + item.lineTotal, 0)
  for (const product of database.products) {
    const requested = saleItems.filter((item) => item.productId === product.id).reduce((sum, item) => sum + item.quantity, 0)
    if (Number(product.stockQuantity || 0) - Number(product.reservedQuantity || 0) < requested) throw new Error(`Not enough available stock for ${product.name}.`)
  }
  const returnItems = returnInputs.map((item) => {
    const originalSale = database.sales.find((sale) => sale.id === item.originalSaleId && (!input.customerId || sale.customerId === input.customerId))
    if (!originalSale) throw new Error('Each cart return must be linked to a previous sale for this customer.')
    const originalItem = item.originalSaleLineId
      ? originalSale.items.find((entry) => entry.lineId === item.originalSaleLineId)
      : originalSale.items.find((entry) => entry.productId === item.productId || entry.code === item.returnCode)
    if (!originalItem) throw new Error('The returned item is not on the linked sale.')
    const quantity = positiveQuantity(item.returnQuantity ?? item.quantity)
    const alreadyReturned = database.returns.filter((entry) => entry.saleId === originalSale.id && (entry.lineId ? entry.lineId === originalItem.lineId : entry.productId === originalItem.productId)).reduce((sum, entry) => sum + Number(entry.quantity || 0), 0)
    if (alreadyReturned + quantity > originalItem.quantity) throw new Error('Return quantity exceeds the amount sold and not yet returned.')
    return { originalSale, originalItem, quantity, condition: item.returnCondition || 'sellable', amount: quantity * Number(originalItem.unitPrice ?? originalItem.price ?? 0) }
  })
  for (let i = 0; i < returnItems.length; i += 1) {
    const current = returnItems.slice(0, i).filter((entry) => entry.originalItem.lineId === returnItems[i].originalItem.lineId && entry.originalSale.id === returnItems[i].originalSale.id).reduce((sum, entry) => sum + entry.quantity, 0)
    const already = database.returns.filter((entry) => entry.saleId === returnItems[i].originalSale.id && entry.lineId === returnItems[i].originalItem.lineId).reduce((sum, entry) => sum + Number(entry.quantity || 0), 0)
    if (already + current + returnItems[i].quantity > returnItems[i].originalItem.quantity) throw new Error('Combined return quantities exceed the amount sold.')
  }
  const discount = amountOf(input.discount ?? 0)
  if (discount > subtotal) throw new Error('Discount cannot exceed the subtotal.')
  const returnTotal = returnItems.reduce((sum, item) => sum + item.amount, 0)
  const saleTotal = subtotal - discount
  const settlementBalance = saleTotal - returnTotal
  const total = Math.max(0, settlementBalance)
  const refundDue = Math.max(0, -settlementBalance)
  const refundType = input.refundType === 'cash' ? 'cash' : 'khata'
  const split = validateSplits(total, input.payments)
  if (split.cash + split.bank + split.cheque > total + 0.005) throw new Error('Combined cash, bank and cheque payments cannot exceed the bill total.')
  if (split.credit > 0 && !input.customerId) throw new Error('Choose a customer before saving a sale with an unpaid balance.')
  const bankDetails = split.bank > 0 ? {
    bankName: String(input.bankDetails?.bankName || '').trim(),
    accountNumber: String(input.bankDetails?.accountNumber || '').trim(),
    amount: split.bank,
  } : null
  const sale = record('sale', {
    number: input.number || `INV-${String((database.counters?.sale || 0) + 1).padStart(4, '0')}`,
    date: dateOf(input.date),
    branchId: normalizeBranchId(input.branchId),
    customerId: input.customerId || null,
    customer: input.customer || database.customers.find((entry) => entry.id === input.customerId)?.name || '',
    customerDetails: input.customerDetails || null,
    customerPhone: input.customerPhone || '',
    customerAddress: input.customerAddress || '',
    padInvoiceNumber: input.padInvoiceNumber || input.paidInvoiceNumber || '',
    items: [...saleItems, ...returnItems.map(({ originalSale, originalItem, quantity, condition, amount }) => ({ lineId: makeId('line'), productId: originalItem.productId, code: originalItem.code, name: `Return · ${originalItem.name}`, quantity, price: -amount / quantity, unitPrice: -amount / quantity, unitCostAtSale: Number(originalItem.unitCostAtSale || 0), lineTotal: -amount, isReturn: true, returnCondition: condition, originalSaleId: originalSale.id, originalSaleLineId: originalItem.lineId }))],
    subtotal,
    discount,
    returnTotal,
    saleTotal,
    total,
    refundDue,
    refundType: refundDue > 0 ? refundType : '',
    ...(idempotencyKey ? { idempotencyKey, idempotencyFingerprint } : {}),
    payments: { cash: split.cash, bank: split.bank, cheque: split.cheque },
    bankDetails,
    paid: split.cash + split.bank,
    due: split.credit,
    paymentDue: input.paymentDue || '',
    status: split.credit > 0 ? 'credit' : 'paid',
  })
  let products = database.products.map((product) => {
    const sold = saleItems.filter((item) => item.productId === product.id).reduce((sum, item) => sum + item.quantity, 0)
    const returnedSellable = returnItems.filter((item) => item.originalItem.productId === product.id && item.condition === 'sellable').reduce((sum, item) => sum + item.quantity, 0)
    const returnedDefective = returnItems.filter((item) => item.originalItem.productId === product.id && item.condition !== 'sellable').reduce((sum, item) => sum + item.quantity, 0)
    return sold || returnedSellable || returnedDefective ? { ...product, stockQuantity: Number(product.stockQuantity || 0) - sold + returnedSellable, defectiveQuantity: Number(product.defectiveQuantity || 0) + returnedDefective } : product
  })
  let stockMovements = database.stockMovements
  for (const item of saleItems) stockMovements = addMovement({ ...database, stockMovements }, { productId: item.productId, type: 'sale', quantity: -item.quantity, referenceId: sale.id, date: sale.date, note: sale.number || 'Sale' })
  let returnRecords = []
  let claims = database.claims
  for (const item of returnItems) {
    const returnRecord = record('return', { saleId: item.originalSale.id, saleNumber: item.originalSale.number, adjustmentSaleId: sale.id, customerId: item.originalSale.customerId, productId: item.originalItem.productId, lineId: item.originalItem.lineId, code: item.originalItem.code, itemName: item.originalItem.name, quantity: item.quantity, unitPrice: item.amount / item.quantity, amount: item.amount, condition: item.condition, refundType: refundDue > 0 ? refundType : 'sale-adjustment', date: sale.date })
    returnRecords.push(returnRecord)
    stockMovements = addMovement({ ...database, stockMovements }, { productId: item.originalItem.productId, type: item.condition === 'sellable' ? 'customer-return' : 'customer-return-defective', quantity: item.quantity, referenceId: returnRecord.id, date: sale.date, note: item.originalSale.number })
    if (item.condition === 'damaged') {
      const product = database.products.find((entry) => entry.id === item.originalItem.productId)
      const claim = record('claim', {
        productId: item.originalItem.productId,
        productName: item.originalItem.name,
        quantity: item.quantity,
        amount: 0,
        description: `Defective product returned by customer on sale ${item.originalSale.number || item.originalSale.id}`,
        date: sale.date,
        status: 'Pending',
        physicalStatus: 'quarantine',
        financialStatus: 'not-applicable',
        sourceType: 'customer-return',
        sourceReturnId: returnRecord.id,
        sourceSaleId: item.originalSale.id,
        saleNumber: item.originalSale.number || '',
        customerId: item.originalSale.customerId || null,
        customer: item.originalSale.customer || '',
        supplierId: product?.supplierId || null,
        supplier: database.suppliers.find((entry) => entry.id === product?.supplierId)?.name || '',
        inventoryManagedBySource: true,
        createdById: String(actor?._id || actor?.id || ''),
        createdByName: actor?.name || '',
      })
      claims = [claim, ...claims]
    }
  }
  let customers = database.customers
  if (sale.customerId && (split.credit > 0 || refundType === 'khata' && refundDue > 0)) {
    customers = updateBalance(customers, sale.customerId, split.credit - (refundType === 'khata' ? refundDue : 0))
  }
  let next = { ...database, products, customers, sales: [sale, ...database.sales], returns: [...returnRecords, ...database.returns], claims, stockMovements }
  if (split.cash > 0) next = { ...next, payments: addPayment(next, { type: 'customer-payment', method: 'cash', amount: split.cash, customerId: sale.customerId, referenceId: sale.id, date: sale.date }) }
  if (refundDue > 0 && refundType === 'cash') next = { ...next, payments: addPayment(next, { type: 'customer-refund', method: 'cash', amount: refundDue, customerId: sale.customerId, referenceId: sale.id, date: sale.date }) }
  if (split.bank > 0) next = { ...next, payments: addPayment(next, { type: 'customer-payment', method: 'bank', amount: split.bank, bankDetails, customerId: sale.customerId, referenceId: sale.id, date: sale.date }) }
  if (split.cheque > 0) next = { ...next, cheques: [record('cheque', { direction: 'received', partyType: 'customer', partyId: sale.customerId, party: sale.customer, amount: split.cheque, issued: input.cheque?.chequeDate || input.cheque?.issued || sale.date, bank: input.cheque?.bank || input.cheque?.bankName || '', number: input.cheque?.number || input.cheque?.chequeNumber || '', expectedClearanceDate: input.cheque?.dueDate || input.cheque?.expectedClearanceDate || '', sourceType: 'sale', referenceId: sale.id, status: 'Pending' }), ...next.cheques] }
  next = { ...next, counters: { ...next.counters, sale: (next.counters.sale || 0) + 1 }, auditHistory: addAudit(next, 'sale', sale.id, `Sale ${sale.number || sale.id} recorded`) }
  return { database: next, record: sale }
}

export function receivePurchase(database, input) {
  const idempotencyKey = String(input.idempotencyKey || '').trim()
  const idempotencyFingerprint = idempotencyKey ? JSON.stringify({
    supplierId: input.supplierId,
    date: dateOf(input.date ?? input.arrivalDate),
    padNumber: String(input.padNumber ?? '').trim(),
    items: (input.items || []).map((item) => ({
      productId: item.productId || null,
      existingProductId: item.existingProductId || null,
      productName: item.productName ?? item.name ?? '',
      code: item.code ?? item.articleNumber ?? '',
      padNumber: item.padNumber ?? '',
      size: item.size ?? '',
      quantity: item.quantity,
      unitCost: item.unitCost ?? item.cost ?? 0,
      salePrice: item.salePrice ?? 0,
      season: item.season || '',
      rackLocation: item.rackLocation ?? item.location ?? '',
    })),
    payments: input.payments || {},
    bankDetails: input.bankDetails || null,
    cheques: input.cheques || [],
  }) : ''
  if (idempotencyKey) {
    const existing = database.purchases.find((entry) => entry.idempotencyKey === idempotencyKey)
    if (existing) {
      if (existing.idempotencyFingerprint !== idempotencyFingerprint) throw new Error('This receiving submission key was already used for different delivery details.')
      return { database, record: existing }
    }
  }
  if (!input.supplierId) throw new Error('Choose a supplier before saving the purchase.')
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('Add at least one stock item before saving the purchase.')
  const supplier = database.suppliers.find((entry) => entry.id === input.supplierId)
  if (!supplier) throw new Error('The selected supplier could not be found.')
  const receivingDate = dateOf(input.date ?? input.arrivalDate)
  const { batchNumber: generatedBatchNumber, supplierBillNumber } = nextReceivingBatch(database, supplier, receivingDate)
  const purchaseItems = input.items.map((item) => ({
    lineId: item.lineId || makeId('purchase-line'),
    productId: item.productId || null,
    existingProductId: item.existingProductId || null,
    productName: String(item.productName ?? item.name ?? item.code ?? item.articleNumber ?? '').trim(),
    code: String(item.code ?? item.articleNumber ?? '').trim(),
    batchNumber: generatedBatchNumber,
    padNumber: String(item.padNumber ?? input.padNumber ?? '').trim(),
    size: String(item.size ?? '').trim(),
    season: String(item.season ?? '').trim(),
    rackLocation: String(item.rackLocation ?? item.location ?? '').trim(),
    quantity: positiveQuantity(item.quantity),
    unitCost: amountOf(item.unitCost ?? item.cost ?? 0),
    salePrice: amountOf(item.salePrice ?? 0),
  }))
  if (purchaseItems.some((item) => item.productId && !database.products.some((product) => product.id === item.productId))) throw new Error('A delivery item points to a stock product that no longer exists.')
  if (purchaseItems.some((item) => !item.productName && (!item.productId || !database.products.some((product) => product.id === item.productId)))) throw new Error('Each delivery item needs an existing product or a product name/article number.')
  const total = purchaseItems.reduce((sum, item) => sum + item.quantity * item.unitCost, 0)
  const cash = amountOf(input.payments?.cash ?? 0)
  const bank = amountOf(input.payments?.bank ?? input.payments?.bankTransfer ?? 0)
  const cheque = amountOf(input.payments?.cheque ?? 0)
  const chequeEntries = Array.isArray(input.cheques) ? input.cheques.map((entry) => ({
    number: String(entry.number || '').trim(),
    bank: String(entry.bank || '').trim(),
    amount: amountOf(entry.amount),
    issued: dateOf(entry.issued ?? input.arrivalDate ?? input.date),
    expectedClearanceDate: entry.expectedClearanceDate || '',
  })) : []
  if (cheque > 0 && !chequeEntries.length) throw new Error('Add at least one cheque for the cheque payment.')
  if (chequeEntries.some((entry) => !entry.number || !entry.bank || !entry.amount)) throw new Error('Each cheque needs a number, bank and positive amount.')
  if (chequeEntries.reduce((sum, entry) => sum + entry.amount, 0) > total + 0.005) throw new Error('Total cheque amount cannot exceed the purchase total.')
  if (chequeEntries.length && Math.abs(chequeEntries.reduce((sum, entry) => sum + entry.amount, 0) - cheque) > 0.005) throw new Error('Cheque entries must add up to the cheque payment amount.')
  if (cash + bank + cheque > total + 0.005) throw new Error('Combined payments cannot exceed the purchase total.')
  let bankDetails = null
  if (bank > 0 || input.bankDetails) {
    const bankName = typeof input.bankDetails?.bankName === 'string' ? input.bankDetails.bankName.trim() : ''
    const accountNumber = typeof input.bankDetails?.accountNumber === 'string' ? input.bankDetails.accountNumber.trim() : ''
    if (!bankName) throw new Error('Select a bank/account or enter a bank name for the bank payment.')
    bankDetails = { bankName, accountNumber, amount: bank }
  }
  const purchase = record('purchase', {
    ...(idempotencyKey ? { idempotencyKey, idempotencyFingerprint } : {}),
    batchNumber: generatedBatchNumber,
    supplierBillNumber,
    padNumber: String(input.padNumber ?? '').trim(),
    supplierId: supplier.id,
    supplier: supplier.name,
    supplierCode: supplier.supplierCode || '',
    date: receivingDate,
    items: purchaseItems,
    total,
    payments: { cash, bank, cheque },
    bankDetails,
    cheques: chequeEntries,
    paid: cash + bank + cheque,
    due: Math.max(0, total - cash - bank - cheque),
  })
  let products = [...database.products]
  let stockMovements = database.stockMovements
  for (const item of purchaseItems) {
    const sameBatch = (entry) =>
      entry.supplierId === supplier.id &&
      String(entry.batchNumber || '').trim().toLowerCase() === item.batchNumber.toLowerCase()
    const reusesExistingProduct = Boolean(item.existingProductId)
    const selectedExistingProduct = reusesExistingProduct ? products.find((entry) => entry.id === item.existingProductId) : null
    if (reusesExistingProduct && !selectedExistingProduct) throw new Error('The selected existing stock product could not be found.')
    if (selectedExistingProduct?.supplierId && selectedExistingProduct.supplierId !== supplier.id) throw new Error('Choose an existing product belonging to the selected supplier.')
    const sourceProduct = (item.productId || item.existingProductId)
      ? products.find((entry) => entry.id === (item.productId || item.existingProductId))
      : null
    if (sourceProduct) {
      item.productName ||= sourceProduct.name
      item.code ||= sourceProduct.code
      item.size ||= sourceProduct.size || ''
      item.rackLocation ||= sourceProduct.rackLocation || ''
    }
    let product = reusesExistingProduct
      ? selectedExistingProduct
      : item.productId
        ? products.find((entry) => entry.id === item.productId && sameBatch(entry))
      : products.find((entry) => item.code && entry.code?.toLowerCase() === item.code.toLowerCase() && sameBatch(entry))
    if (!product && item.productName) product = products.find((entry) => entry.name.toLowerCase() === item.productName.toLowerCase() && sameBatch(entry))
    if (product) {
      item.productId = product.id
      products = products.map((entry) => entry.id === product.id ? {
        ...entry,
        stockQuantity: Number(entry.stockQuantity || 0) + item.quantity,
        averageCost: ((Number(entry.stockQuantity || 0) * Number(entry.averageCost || 0)) + (item.quantity * item.unitCost)) / (Number(entry.stockQuantity || 0) + item.quantity || 1),
        salePrice: item.salePrice || Number(entry.salePrice || 0),
        ...(!entry.supplierId ? { supplierId: supplier.id } : {}),
        ...(!reusesExistingProduct && !item.productId ? { batchNumber: purchase.batchNumber, purchaseId: purchase.id, arrivalDate: purchase.date } : {}),
        size: item.size || entry.size || '',
        season: item.season || entry.season || '',
        rackLocation: item.rackLocation || entry.rackLocation,
      } : entry)
      stockMovements = addMovement({ ...database, stockMovements }, { productId: product.id, type: 'purchase', quantity: item.quantity, referenceId: purchase.id, date: purchase.date, note: item.batchNumber })
    } else {
      const newProduct = record('product', { name: item.productName, code: item.code || makeId('sku'), categoryId: null, size: item.size, season: item.season, stockQuantity: item.quantity, reservedQuantity: 0, defectiveQuantity: 0, averageCost: item.unitCost, salePrice: item.salePrice, supplierId: supplier.id, batchNumber: item.batchNumber, rackLocation: item.rackLocation, active: true })
      newProduct.purchaseId = purchase.id
      newProduct.arrivalDate = purchase.date
      products.push(newProduct)
      purchaseItems[purchaseItems.indexOf(item)] = { ...item, productId: newProduct.id }
      stockMovements = addMovement({ ...database, stockMovements }, { productId: newProduct.id, type: 'purchase', quantity: item.quantity, referenceId: purchase.id, date: purchase.date, note: item.batchNumber })
    }
  }
  for (const item of purchaseItems) item.productName = item.productName || products.find((product) => product.id === item.productId)?.name || ''
  purchase.items = purchaseItems
  let suppliers = database.suppliers
  if (purchase.due > 0) suppliers = updateBalance(suppliers, supplier.id, purchase.due)
  let next = { ...database, products, suppliers, purchases: [purchase, ...database.purchases], stockMovements }
  if (cash > 0) next = { ...next, payments: addPayment(next, { type: 'supplier-payment', method: 'cash', amount: cash, supplierId: supplier.id, referenceId: purchase.id, date: purchase.date }) }
  if (bank > 0) next = { ...next, payments: addPayment(next, { type: 'supplier-payment', method: 'bank', amount: bank, bankDetails, supplierId: supplier.id, referenceId: purchase.id, date: purchase.date }) }
  if (cheque > 0) next = { ...next, payments: addPayment(next, { type: 'supplier-payment', method: 'cheque', amount: cheque, supplierId: supplier.id, referenceId: purchase.id, date: purchase.date }), cheques: [...chequeEntries.map((entry) => record('cheque', { direction: 'given', partyType: 'supplier', partyId: supplier.id, party: supplier.name, ...entry, referenceId: purchase.id, sourceType: 'purchase', appliedToBalance: true, status: 'Pending' })), ...next.cheques] }
  next = { ...next,     counters: { ...next.counters, supplierReceivings: { ...next.counters?.supplierReceivings, [supplier.id]: supplierBillNumber } }, auditHistory: addAudit(next, 'purchase', purchase.id, `Receive stock ${purchase.batchNumber} recorded`) }
  return { database: next, record: purchase }
}

export function updatePurchase(database, input) {
  const purchase = database.purchases.find((entry) => entry.id === input.purchaseId)
  if (!purchase) throw new Error('Purchase could not be found.')
  if (input.appendStock === true) return appendPurchaseItems(database, purchase, input)
  if (input.supplierId && input.supplierId !== purchase.supplierId) throw new Error('A received purchase cannot be moved to another supplier.')
  if (database.supplierReturns.some((entry) => entry.purchaseId === purchase.id)) throw new Error('This delivery has supplier returns and cannot be edited safely.')
  if (!Array.isArray(input.items) || input.items.length !== purchase.items.length) throw new Error('Keep the delivery item lines unchanged while editing this bill.')
  const originalByLine = new Map(purchase.items.map((item, index) => [item.lineId || `legacy-line-${index}`, item]))
  const seenLineIds = new Set()
  const items = input.items.map((submitted) => {
    const lineId = String(submitted.lineId || '')
    const original = originalByLine.get(lineId)
    if (!original || seenLineIds.has(lineId)) throw new Error('Delivery item lines must match the saved bill.')
    seenLineIds.add(lineId)
    const product = database.products.find((entry) => entry.id === original.productId) || database.products.find((entry) =>
      entry.supplierId === purchase.supplierId
      && String(entry.batchNumber || '').toLowerCase() === String(original.batchNumber || purchase.batchNumber || '').toLowerCase()
      && (original.code && entry.code === original.code || original.productName && entry.name === original.productName))
    if (!product) throw new Error('A delivery stock product could not be found.')
    if (submitted.productId && submitted.productId !== product.id) throw new Error('A received item cannot be reassigned to a different stock product.')
    return {
      ...original,
      lineId,
      productId: product.id,
      productName: String(submitted.productName ?? submitted.name ?? original.productName).trim(),
      code: String(submitted.code ?? submitted.articleNumber ?? original.code).trim(),
      size: String(submitted.size ?? original.size ?? '').trim(),
      season: String(submitted.season ?? original.season ?? '').trim(),
      rackLocation: String(submitted.rackLocation ?? submitted.location ?? original.rackLocation ?? '').trim(),
      quantity: positiveQuantity(submitted.quantity),
      unitCost: amountOf(submitted.unitCost ?? submitted.cost ?? original.unitCost),
      salePrice: amountOf(submitted.salePrice ?? original.salePrice),
      batchNumber: original.batchNumber || purchase.batchNumber,
    }
  })
  const date = dateOf(input.date ?? input.arrivalDate ?? purchase.date)
  const total = items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0)
  const cash = amountOf(input.payments?.cash ?? purchase.payments?.cash ?? 0)
  const bank = amountOf(input.payments?.bank ?? input.payments?.bankTransfer ?? purchase.payments?.bank ?? 0)
  const cheque = amountOf(input.payments?.cheque ?? purchase.payments?.cheque ?? 0)
  if (cash + bank + cheque > total + 0.005) throw new Error('Combined payments cannot exceed the purchase total.')
  const bankDetails = bank > 0 ? {
    bankName: String(input.bankDetails?.bankName ?? purchase.bankDetails?.bankName ?? '').trim(),
    accountNumber: String(input.bankDetails?.accountNumber ?? purchase.bankDetails?.accountNumber ?? '').trim(),
    amount: bank,
  } : null
  if (bank > 0 && !bankDetails.bankName) throw new Error('Select a bank/account or enter a bank name for the bank payment.')
  const submittedCheques = Array.isArray(input.cheques) ? input.cheques.map((entry) => ({
    number: String(entry.number || '').trim(),
    bank: String(entry.bank || '').trim(),
    amount: amountOf(entry.amount),
    issued: dateOf(entry.issued ?? date),
    expectedClearanceDate: entry.expectedClearanceDate || '',
  })) : purchase.cheques || []
  const chequeEntries = cheque > 0 ? submittedCheques : []
  if (cheque > 0 && !chequeEntries.length) throw new Error('Add at least one cheque for the cheque payment.')
  if (chequeEntries.some((entry) => !entry.number || !entry.bank || !entry.amount)) throw new Error('Each cheque needs a number, bank and positive amount.')
  if (Math.abs(chequeEntries.reduce((sum, entry) => sum + entry.amount, 0) - cheque) > 0.005) throw new Error('Cheque entries must add up to the cheque payment amount.')

  const activeCheques = database.cheques.filter((entry) => entry.sourceType === 'purchase' && entry.referenceId === purchase.id && entry.status !== 'Cancelled')
  const chequeChanged = cheque !== Number(purchase.payments?.cheque || 0)
    || JSON.stringify(chequeEntries) !== JSON.stringify((purchase.cheques || []).map(({ number, bank, amount, issued, expectedClearanceDate }) => ({ number, bank, amount, issued, expectedClearanceDate })))
  if (chequeChanged && activeCheques.some((entry) => entry.status !== 'Pending')) throw new Error('A cleared or resolved supplier cheque cannot be changed while editing a delivery.')

  const oldDue = Number(purchase.due || 0)
  const due = Math.max(0, total - cash - bank - cheque)
  const updatedPurchase = {
    ...purchase,
    padNumber: input.padNumber == null ? purchase.padNumber || '' : String(input.padNumber).trim(),
    date,
    items,
    total,
    payments: { cash, bank, cheque },
    bankDetails,
    cheques: chequeEntries,
    paid: cash + bank + cheque,
    due,
  }
  let products = [...database.products]
  for (const item of items) {
    const original = originalByLine.get(item.lineId)
    const deltaQuantity = item.quantity - Number(original.quantity || 0)
    const product = products.find((entry) => entry.id === item.productId)
    const stockQuantity = Number(product.stockQuantity || 0) + deltaQuantity
    if (stockQuantity < Number(product.reservedQuantity || 0)) throw new Error(`Cannot reduce ${product.name} below its reserved or already-used stock.`)
    const costDelta = item.quantity * item.unitCost - Number(original.quantity || 0) * Number(original.unitCost || 0)
    const averageCost = stockQuantity > 0
      ? Math.max(0, (Number(product.stockQuantity || 0) * Number(product.averageCost || 0) + costDelta) / stockQuantity)
      : item.unitCost
    products = products.map((entry) => entry.id === product.id ? {
      ...entry,
      name: item.productName || entry.name,
      code: item.code || entry.code,
      size: item.size || '',
      season: item.season || '',
      rackLocation: item.rackLocation || '',
      salePrice: item.salePrice,
      stockQuantity,
      averageCost,
      arrivalDate: date,
    } : entry)
  }
  const suppliers = updateBalance(database.suppliers, purchase.supplierId, due - oldDue)
  let stockMovements = database.stockMovements.filter((entry) => entry.type !== 'purchase' || entry.referenceId !== purchase.id)
  for (const item of items) stockMovements = addMovement({ ...database, stockMovements }, {
    productId: item.productId,
    type: 'purchase',
    quantity: item.quantity,
    referenceId: purchase.id,
    date,
    note: item.batchNumber || purchase.batchNumber || purchase.id,
  })

  let payments = database.payments.filter((entry) => !(entry.type === 'supplier-payment' && entry.referenceId === purchase.id))
  for (const [method, amount] of [['cash', cash], ['bank', bank], ['cheque', cheque]]) {
    if (amount > 0) payments = addPayment({ ...database, payments }, {
      type: 'supplier-payment',
      method,
      amount,
      ...(method === 'bank' ? { bankDetails } : {}),
      supplierId: purchase.supplierId,
      referenceId: purchase.id,
      date,
    })
  }
  let cheques = database.cheques
  if (chequeChanged) {
    cheques = cheques.filter((entry) => !(entry.sourceType === 'purchase' && entry.referenceId === purchase.id && entry.status === 'Pending'))
    if (cheque > 0) cheques = [
      ...chequeEntries.map((entry) => record('cheque', {
        direction: 'given',
        partyType: 'supplier',
        partyId: purchase.supplierId,
        party: purchase.supplier,
        ...entry,
        referenceId: purchase.id,
        sourceType: 'purchase',
        appliedToBalance: true,
        status: 'Pending',
      })),
      ...cheques,
    ]
  } else if (cheque > 0) {
    cheques = cheques.map((entry) => entry.sourceType === 'purchase' && entry.referenceId === purchase.id && entry.status === 'Pending'
      ? { ...entry, issued: entry.issued || date }
      : entry)
  }
  const next = {
    ...database,
    products,
    suppliers,
    purchases: database.purchases.map((entry) => entry.id === purchase.id ? updatedPurchase : entry),
    payments,
    cheques,
    stockMovements,
    auditHistory: addAudit(database, 'purchase-edit', purchase.id, `Receive stock ${purchase.batchNumber || purchase.id} updated`),
  }
  return { database: next, record: updatedPurchase }
}

function appendPurchaseItems(database, purchase, input) {
  if (input.supplierId && input.supplierId !== purchase.supplierId) throw new Error('A received purchase cannot be moved to another supplier.')
  if (database.supplierReturns.some((entry) => entry.purchaseId === purchase.id)) throw new Error('This delivery has supplier returns and cannot be edited safely.')
  if (!Array.isArray(input.appendItems) || input.appendItems.length === 0) throw new Error('Add at least one new stock item before saving.')
  const idempotencyKey = String(input.appendIdempotencyKey || '').trim()
  if (!idempotencyKey) throw new Error('A delivery-item submission key is required.')
  const fingerprint = JSON.stringify(input.appendItems.map((item) => ({
    existingProductId: item.existingProductId || null,
    productName: item.productName ?? item.name ?? '',
    code: item.code ?? item.articleNumber ?? '',
    padNumber: item.padNumber ?? '',
    quantity: item.quantity,
    unitCost: item.unitCost ?? item.cost ?? 0,
    salePrice: item.salePrice ?? 0,
    season: item.season || '',
  })))
  const previousOperation = (purchase.appendOperations || []).find((entry) => entry.idempotencyKey === idempotencyKey)
  if (previousOperation) {
    if (previousOperation.fingerprint !== fingerprint) throw new Error('This add-stock submission key was already used for different item details.')
    return { database, record: purchase }
  }
  const supplier = database.suppliers.find((entry) => entry.id === purchase.supplierId)
  if (!supplier) throw new Error('The delivery supplier could not be found.')
  const date = purchase.date || dateOf(input.date)
  const { batchNumber, supplierBillNumber } = nextReceivingBatch(database, supplier, date)
  const items = input.appendItems.map((submitted) => {
    const productName = String(submitted.productName ?? submitted.name ?? submitted.articleNumber ?? submitted.code ?? '').trim()
    const code = String(submitted.code ?? submitted.articleNumber ?? '').trim()
    if (!productName && !submitted.existingProductId) throw new Error('Each added stock item needs an article/design number or an existing product.')
    return {
      lineId: makeId('purchase-line'),
      productId: null,
      existingProductId: submitted.existingProductId || null,
      productName,
      code,
      padNumber: String(submitted.padNumber ?? purchase.padNumber ?? '').trim(),
      batchNumber,
      size: String(submitted.size ?? '').trim(),
      season: String(submitted.season ?? '').trim(),
      rackLocation: String(submitted.rackLocation ?? submitted.location ?? '').trim(),
      quantity: positiveQuantity(submitted.quantity),
      unitCost: amountOf(submitted.unitCost ?? submitted.cost ?? 0),
      salePrice: amountOf(submitted.salePrice ?? 0),
    }
  })
  let products = [...database.products]
  let stockMovements = [...database.stockMovements]
  for (const item of items) {
    let product = null
    if (item.existingProductId) {
      product = products.find((entry) => entry.id === item.existingProductId)
      if (!product) throw new Error('The selected existing stock product could not be found.')
      if (product.supplierId && product.supplierId !== supplier.id) throw new Error('Choose an existing product belonging to the delivery supplier.')
      const previousQuantity = Number(product.stockQuantity || 0)
      const nextQuantity = previousQuantity + item.quantity
      item.productId = product.id
      item.productName ||= product.name
      item.code ||= product.code
      products = products.map((entry) => entry.id === product.id ? {
        ...entry,
        stockQuantity: nextQuantity,
        averageCost: ((previousQuantity * Number(entry.averageCost || 0)) + (item.quantity * item.unitCost)) / (nextQuantity || 1),
        salePrice: item.salePrice || Number(entry.salePrice || 0),
        season: item.season || entry.season || '',
        ...(!entry.supplierId ? { supplierId: supplier.id } : {}),
      } : entry)
    } else {
      product = record('product', {
        name: item.productName,
        code: item.code || makeId('sku'),
        categoryId: null,
        size: item.size,
        season: item.season,
        stockQuantity: item.quantity,
        reservedQuantity: 0,
        defectiveQuantity: 0,
        averageCost: item.unitCost,
        salePrice: item.salePrice,
        supplierId: supplier.id,
        batchNumber,
        rackLocation: item.rackLocation,
        active: true,
        purchaseId: purchase.id,
        arrivalDate: date,
      })
      item.productId = product.id
      products.push(product)
    }
    stockMovements = addMovement({ ...database, stockMovements }, {
      productId: item.productId,
      type: 'purchase',
      quantity: item.quantity,
      referenceId: purchase.id,
      date,
      note: item.batchNumber,
    })
  }
  const appendedCost = items.reduce((sum, item) => sum + item.quantity * item.unitCost, 0)
  const total = Number(purchase.total || 0) + appendedCost
  const payments = purchase.payments || { cash: 0, bank: 0, cheque: 0 }
  const paid = Number(purchase.paid ?? (Number(payments.cash || 0) + Number(payments.bank || payments.bankTransfer || 0) + Number(payments.cheque || 0)))
  const due = Math.max(0, total - paid)
  const updatedPurchase = {
    ...purchase,
    items: [...purchase.items, ...items],
    total,
    paid,
    due,
    appendOperations: [...(purchase.appendOperations || []), { idempotencyKey, fingerprint, batchNumber, itemIds: items.map((item) => item.lineId), createdAt: now() }],
  }
  const suppliers = updateBalance(database.suppliers, supplier.id, due - Number(purchase.due || 0))
  const next = {
    ...database,
    products,
    suppliers,
    purchases: database.purchases.map((entry) => entry.id === purchase.id ? updatedPurchase : entry),
    stockMovements,
    counters: {
      ...database.counters,
      supplierReceivings: {
        ...database.counters?.supplierReceivings,
        [supplier.id]: Math.max(Number(database.counters?.supplierReceivings?.[supplier.id] || 0), supplierBillNumber),
      },
    },
    auditHistory: addAudit(database, 'purchase-stock-addition', purchase.id, `Stock added to delivery ${batchNumber}`),
  }
  return { database: next, record: updatedPurchase }
}

export function createAccount(database, accountType, input) {
  const key = accountType === 'customer' ? 'customers' : accountType === 'supplier' ? 'suppliers' : null
  if (!key) throw new Error('Account type must be customer or supplier.')
  const name = String(input.name || '').trim()
  if (!name) throw new Error(`${accountType} name is required.`)
  if (database[key].some((entry) => entry.name.trim().toLowerCase() === name.toLowerCase())) throw new Error(`A ${accountType} with this name already exists.`)
  const supplierCode = accountType === 'supplier' ? String(input.supplierCode || '').trim().toUpperCase() : ''
  if (accountType === 'supplier' && supplierCode && database.suppliers.some((entry) => String(entry.supplierCode || '').trim().toUpperCase() === supplierCode)) throw new Error('A supplier with this code already exists.')
  const openingBalance = Number(input.openingBalance ?? 0)
  if (!Number.isFinite(openingBalance)) throw new Error('Opening balance must be a valid amount.')
  const account = record(accountType, { ...input, name, ...(accountType === 'supplier' ? { supplierCode } : {}), openingBalance, balance: openingBalance, active: true })
  const next = { ...database, [key]: [account, ...database[key]], auditHistory: addAudit(database, accountType, account.id, `${accountType} account created`) }
  return { database: next, record: account }
}

export function createProduct(database, input) {
  const name = String(input.name || '').trim()
  if (!name) throw new Error('Product name is required.')
  const code = String(input.code || '').trim()
  const batchNumber = String(input.batchNumber || '').trim().toLowerCase()
  const size = String(input.size || '').trim().toLowerCase()
  if (database.products.some((entry) => (code && entry.code?.toLowerCase() === code.toLowerCase() || entry.name.toLowerCase() === name.toLowerCase()) && String(entry.batchNumber || '').trim().toLowerCase() === batchNumber && String(entry.size || '').trim().toLowerCase() === size)) throw new Error('This product, batch, and size already exists.')
  const stockQuantity = nonnegativeWholeQuantity(input.stockQuantity ?? 0)
  const product = record('product', { ...input, name, code: code || makeId('sku'), batchNumber: String(input.batchNumber || '').trim(), size: String(input.size || '').trim(), stockQuantity, reservedQuantity: 0, defectiveQuantity: 0, averageCost: amountOf(input.averageCost ?? 0), salePrice: amountOf(input.salePrice ?? 0), active: true })
  const next = { ...database, products: [product, ...database.products], auditHistory: addAudit(database, 'product', product.id, `Product ${product.name} created`) }
  return { database: next, record: product }
}

export function adjustStock(database, input) {
  const product = database.products.find((entry) => entry.id === input.productId)
  if (!product) throw new Error('Product could not be found.')
  const quantity = positiveQuantity(input.quantity)
  const direction = input.direction === 'remove' ? -1 : input.direction === 'add' ? 1 : 0
  if (!direction) throw new Error('Stock adjustment must add or remove stock.')
  const current = Number(product.stockQuantity || 0)
  if (direction < 0 && current - quantity < Number(product.reservedQuantity || 0)) throw new Error('Stock cannot be reduced below the amount reserved for held orders.')
  const result = record('adjustment', { productId: product.id, quantity: direction * quantity, reason: input.reason || '', date: dateOf(input.date) })
  const products = database.products.map((entry) => entry.id === product.id ? { ...entry, stockQuantity: current + direction * quantity } : entry)
  const stockMovements = addMovement(database, { productId: product.id, type: 'adjustment', quantity: result.quantity, referenceId: result.id, date: result.date, note: result.reason })
  const next = { ...database, products, stockMovements, auditHistory: addAudit(database, 'stock-adjustment', result.id, `Stock ${direction > 0 ? 'increased' : 'decreased'} for ${product.name}`) }
  return { database: next, record: result }
}

export function recordStockCountAudit(database, input) {
  const date = dateOf(input.date)
  const period = input.period === 'weekly' ? 'weekly' : 'monthly'
  const periodKey = period === 'monthly' ? date.slice(0, 7) : date
  if (!Array.isArray(input.items)) throw new Error('Review every stock item before saving the audit.')
  const submitted = new Map()
  for (const item of input.items) {
    if (!item?.productId || submitted.has(item.productId)) throw new Error('Each stock item must be included once in the audit.')
    submitted.set(item.productId, item.countedAvailable)
  }
  if (submitted.size !== database.products.length || database.products.some((product) => !submitted.has(product.id))) {
    throw new Error('Review every stock item before saving the audit.')
  }

  let working = database
  const items = []
  for (const product of database.products) {
    const countedAvailable = nonnegativeWholeQuantity(submitted.get(product.id))
    const reserved = Number(product.reservedQuantity || 0)
    const currentAvailable = Number(product.stockQuantity || 0) - reserved
    const difference = countedAvailable - currentAvailable
    if (difference) {
      working = adjustStock(working, {
        productId: product.id,
        direction: difference > 0 ? 'add' : 'remove',
        quantity: Math.abs(difference),
        date,
        reason: `Stock audit ${period} count correction`,
      }).database
    }
    items.push({
      productId: product.id,
      articleName: product.article || product.code || '',
      brandName: product.name,
      supplierId: product.supplierId || '',
      batchNumber: product.batchNumber || '',
      currentAvailable,
      countedAvailable,
      difference,
      costPerSuit: Number(product.averageCost || 0),
    })
  }
  const audit = record('stock-audit', { period, periodKey, date, items })
  const stockAudits = [...(working.stockAudits || []), audit]
  const next = { ...working, stockAudits, auditHistory: addAudit(working, 'stock-audit', audit.id, `${period} stock audit completed for ${date}`) }
  return { database: next, record: audit }
}

export function assertDueCustomerChequesUpdated(database, date) {
  const finalStatuses = new Set(['Cleared', 'Returned', 'Cancelled', 'Bounced', 'Bounced / Dishonoured', 'Replaced'])
  const due = (database.cheques || []).filter(cheque => cheque.direction === 'received'
    && cheque.partyType !== 'supplier'
    && String(cheque.expectedClearanceDate || cheque.dueDate || '').slice(0, 10) === date
    && !finalStatuses.has(cheque.status))
  if (due.length) throw new Error('Update the status of customer cheques due on ' + date + ' before daily closing: ' + due.map(cheque => cheque.number || cheque.id).join(', ') + '. Mark cleared, returned/bounced, cancelled, replaced, or reschedule to the correct future date.')
}

export function saveDailyRecord(database, input, actor = null) {
  const date = dateOf(input.date)
  const type = input.type === 'opening' ? 'opening' : 'closing'
  if (type === 'closing') assertDueCustomerChequesUpdated(database, date)
  const branchId = normalizeBranchId(input.branchId)
  if (type === 'closing' && !database.dailyClosings.some((entry) => entry.date === date && entry.type === 'opening' && recordMatchesBranch(entry, branchId))) {
    throw new Error('Save the daily opening before recording the daily closing.')
  }
  const [year, month, day] = date.split('-').map(Number)
  const isMonthEnd = Number.isInteger(day) && day === new Date(Date.UTC(year, month, 0)).getUTCDate()
  const monthlyAudit = [...(database.stockAudits || [])].reverse().find((audit) => audit.period === 'monthly' && audit.periodKey === date.slice(0, 7) && audit.date === date)
  const auditedCounts = new Map((monthlyAudit?.items || []).map((item) => [item.productId, Number(item.countedAvailable)]))
  const stockAuditIsCurrent = Boolean(monthlyAudit)
    && auditedCounts.size === database.products.length
    && database.products.every((product) => auditedCounts.get(product.id) === Number(product.stockQuantity || 0) - Number(product.reservedQuantity || 0))
  if (type === 'closing' && isMonthEnd && !stockAuditIsCurrent) {
    throw new Error('Complete the monthly stock audit before saving this month-end closing.')
  }
  const amount = amountOf(input.amount)
  const existing = database.dailyClosings.find((entry) => entry.date === date && entry.type === type && recordMatchesBranch(entry, branchId))
  if (type === 'opening' && existing && actor && actor.role !== 'admin' && actor.permissions?.admin !== true) {
    const error = new Error('Only an administrator can edit a saved daily opening.')
    error.status = 403
    throw error
  }
  const counted = input.counted == null ? existing?.counted ?? null : amountOf(input.counted)
  const changed = Boolean(existing && (Number(existing.amount) !== amount || Number(existing.counted ?? existing.amount) !== Number(counted ?? amount) || String(existing.note || '') !== String(input.note || '')))
  if (existing?.finalized && changed && !String(input.correctionReason || '').trim()) throw new Error('Enter a correction reason to update a finalized daily record.')
  const correction = changed && existing?.finalized ? {
    date: now(),
    userId: String(actor?._id || ''),
    userName: actor?.name || '',
    reason: String(input.correctionReason).trim(),
    previous: { amount: existing.amount, counted: existing.counted, note: existing.note || '' },
    updated: { amount, counted, note: input.note || '' },
  } : null
  const dailyRecord = existing
    ? { ...existing, amount, counted, note: input.note || '', updatedAt: now(), updatedById: String(actor?._id || ''), updatedByName: actor?.name || '', ...(correction ? { correctionHistory: [...(existing.correctionHistory || []), correction] } : {}) }
    : record('daily', { date, branchId, type, amount, counted, note: input.note || '', ...(type === 'closing' && actor ? { finalized: true, closedAt: now(), closedById: String(actor._id), closedByName: actor.name || '' } : {}) })
  const dailyClosings = existing ? database.dailyClosings.map((entry) => entry.id === existing.id ? dailyRecord : entry) : [dailyRecord, ...database.dailyClosings]
  const description = correction ? `Daily ${type} corrected for ${date}: ${correction.reason}` : `Daily ${type} saved for ${date}`
  const next = { ...database, dailyClosings, auditHistory: addAudit(database, correction ? `daily-${type}-corrected` : `daily-${type}`, dailyRecord.id, description) }
  return { database: next, record: dailyRecord }
}

export function deleteDailyRecord(database, recordId) {
  const existing = database.dailyClosings.find((entry) => entry.id === recordId)
  if (!existing) throw new Error('Daily record could not be found.')
  if (existing.finalized) throw new Error('A finalized daily closing cannot be deleted. Record a correction with an audit reason instead.')
  if (existing.type === 'opening' && database.dailyClosings.some((entry) => entry.date === existing.date && entry.type === 'closing' && recordMatchesBranch(entry, existing.branchId))) {
    throw new Error('Delete the daily closing before deleting its opening.')
  }
  const next = {
    ...database,
    dailyClosings: database.dailyClosings.filter((entry) => entry.id !== recordId),
    auditHistory: addAudit(database, 'daily-record-deleted', existing.id, `Daily ${existing.type} deleted for ${existing.date}`),
  }
  return { database: next, record: existing }
}

export function saveSettings(database, settings) {
  if (settings.language != null && !['en', 'ur'].includes(settings.language)) throw new Error('Language must be English or Urdu.')
  const shopName = String(settings.shopName || '').trim()
  if (!shopName) throw new Error('Shop name is required.')
  const stockThreshold = Number(settings.stockThreshold)
  if (!Number.isInteger(stockThreshold) || stockThreshold < 0) throw new Error('Low-stock threshold must be a non-negative whole number.')
  const nextSettings = { ...database.settings, ...settings, shopName, stockThreshold: String(stockThreshold), receiptFooter: String(settings.receiptFooter || '').trim() }
  const next = { ...database, settings: nextSettings, auditHistory: addAudit(database, 'settings', 'shop', 'Shop settings updated') }
  return { database: next, record: nextSettings }
}

export function createClaim(database, input) {
  const quantity = positiveQuantity(input.quantity)
  if (!input.description?.trim() && !input.reason?.trim()) throw new Error('Enter a reason or description for the claim.')
  let alreadyDefective = 0
  if (input.productId) {
    const product = database.products.find((entry) => entry.id === input.productId)
    if (!product) throw new Error('The claimed product could not be found.')
    const pendingClaimQuantity = database.claims.filter((claim) => claim.productId === input.productId && claim.status === 'Pending').reduce((sum, claim) => sum + Number(claim.quantity || 0), 0)
    alreadyDefective = Math.min(quantity, Math.max(0, Number(product.defectiveQuantity || 0) - pendingClaimQuantity))
    const toQuarantine = quantity - alreadyDefective
    if (Number(product.stockQuantity || 0) - Number(product.reservedQuantity || 0) < toQuarantine) throw new Error('Claim quantity exceeds available and defective stock.')
  }
  if (input.supplierId && !database.suppliers.some((supplier) => supplier.id === input.supplierId)) throw new Error('The claim supplier could not be found.')
  const claimedProduct = database.products.find((entry) => entry.id === input.productId)
  const claim = record('claim', { ...input, amount: quantity * Number(claimedProduct?.averageCost || 0), description: String(input.description || input.reason).trim(), quantity, date: dateOf(input.date), status: 'Pending' })
  let products = database.products
  let stockMovements = database.stockMovements
  if (claim.productId) {
    const toQuarantine = quantity - alreadyDefective
    products = products.map((entry) => entry.id === claim.productId ? { ...entry, stockQuantity: Number(entry.stockQuantity || 0) - toQuarantine, defectiveQuantity: Number(entry.defectiveQuantity || 0) + toQuarantine } : entry)
    stockMovements = addMovement(database, { productId: claim.productId, type: 'defect-claim', quantity: -quantity, referenceId: claim.id, date: claim.date, note: claim.description })
  }
  const next = { ...database, products, stockMovements, claims: [claim, ...database.claims], auditHistory: addAudit(database, 'claim', claim.id, 'Defect or claim recorded') }
  return { database: next, record: claim }
}

export function updateClaimStatus(database, claimId, status, resolution = '') {
  if (!['Approved', 'Rejected', 'Resolved', 'Replacement'].includes(status)) throw new Error('Choose an approved, rejected, resolved, or replacement status.')
  const claim = database.claims.find((entry) => entry.id === claimId)
  if (!claim) throw new Error('Claim could not be found.')
  if (claim.status === status) return { database, record: claim }
  if (claim.status !== 'Pending' && claim.status !== status) throw new Error('Only pending claims can change status.')
  const updated = { ...claim, status, resolution, updatedAt: now(), financialStatus: status === 'Rejected' ? 'rejected' : status === 'Approved' || status === 'Replacement' ? 'credited' : claim.financialStatus || 'pending', physicalStatus: status === 'Replacement' ? 'replaced' : status === 'Rejected' ? 'rejected' : status === 'Approved' ? 'dispatched' : claim.physicalStatus || 'quarantine' }
  const suppliers = (status === 'Approved' || status === 'Replacement') && claim.supplierId ? updateBalance(database.suppliers, claim.supplierId, -Number(claim.amount || 0)) : database.suppliers
  let products = database.products
  let stockMovements = database.stockMovements
  if ((status === 'Approved' || status === 'Replacement') && claim.productId && !claim.inventoryManagedBySource) {
    products = products.map((product) => product.id === claim.productId ? {
      ...product,
      defectiveQuantity: Math.max(0, Number(product.defectiveQuantity || 0) - claim.quantity),
      stockQuantity: status === 'Replacement' ? Number(product.stockQuantity || 0) + claim.quantity : Number(product.stockQuantity || 0),
    } : product)
    stockMovements = addMovement(database, { productId: claim.productId, type: status === 'Replacement' ? 'claim-replacement' : 'approved-claim', quantity: status === 'Replacement' ? claim.quantity : -claim.quantity, referenceId: claim.id, date: dateOf(), note: claim.description })
  }
  const next = { ...database, products, stockMovements, suppliers, claims: database.claims.map((entry) => entry.id === claimId ? updated : entry), auditHistory: addAudit(database, 'claim-status', claimId, `Claim marked ${status.toLowerCase()}`) }
  return { database: next, record: updated }
}

export function runDatabaseCommand(database, command, input = {}, context = {}) {
  const branchId = normalizeBranchId(context.branchId || context.actor?.branchId || database.business?.branchId)
  const businessDate = context.businessDate || businessDateString()
  switch (command) {
    case 'create-sale': {
      if (input.idempotencyKey && database.sales.some((sale) => sale.idempotencyKey === String(input.idempotencyKey).trim())) return createSale(database, input)
      assertSaleDayOpen(database, { date: businessDate, branchId })
      return createSale(database, { ...input, date: businessDate, branchId }, { actor: context.actor })
    }
    case 'receive-purchase': return receivePurchase(database, input)
    case 'update-purchase': return updatePurchase(database, input)
    case 'customer-return': return processCustomerReturn(database, input)
    case 'supplier-return': return processSupplierReturn(database, input)
    case 'account-payment': return recordAccountPayment(database, input)
    case 'expense': return recordExpense(database, input)
    case 'cheque-status': return updateChequeStatus(database, input.chequeId, input.status, { actor: context.actor, remarks: input.remarks, bounceDate: input.bounceDate, bounceReason: input.bounceReason, bankCharges: input.bankCharges })
    case 'cheque-details': return updateChequeDetails(database, input, context.actor)
    case 'hold-order': return recordHeldOrder(database, input)
    case 'release-held-order': return releaseHeldOrder(database, input.heldId, 'resumed')
    case 'discard-held-order': return releaseHeldOrder(database, input.heldId, 'discarded')
    case 'create-customer': return createAccount(database, 'customer', input)
    case 'create-supplier': return createAccount(database, 'supplier', input)
    case 'create-product': return createProduct(database, input)
    case 'adjust-stock': return adjustStock(database, input)
    case 'stock-audit': return recordStockCountAudit(database, input)
    case 'daily-record': return saveDailyRecord(database, { ...input, branchId }, context.actor)
    case 'delete-daily-record': return deleteDailyRecord(database, input.recordId)
    case 'create-bank-account': return createBankAccount(database, input, context.actor)
    case 'update-bank-account': return updateBankAccount(database, input, context.actor)
    case 'bank-transaction': return recordBankTransaction(database, input, context.actor)
    case 'save-bank-balances': return saveBankBalances(database, input, context.actor)
    case 'save-settings': return saveSettings(database, input)
    case 'create-claim': return createClaim(database, input)
    case 'claim-status': return updateClaimStatus(database, input.claimId, input.status, input.resolution)
    case 'claim-update': return updateClaimDetails(database, input)
    case 'create-cheque': return createManualCheque(database, input, context.actor)
    case 'partial-deliver-held-order': {
      assertSaleDayOpen(database, { date: businessDate, branchId })
      return partialDeliverHeldOrder(database, { ...input, date: businessDate, branchId })
    }
    case 'complete-held-order': {
      assertSaleDayOpen(database, { date: businessDate, branchId })
      return completeHeldOrder(database, { ...input, date: businessDate, branchId })
    }
    case 'finance': return recordFinanceEntry(database, input)
    case 'bulk-recovery': return bulkAccountRecovery(database, input)
    case 'create-installment': return createInstallmentPlan(database, input)
    case 'installment-payment': return receiveInstallmentPayment(database, input)
    case 'update-product': return updateProductDetails(database, input)
    case 'update-account': return updateAccountDetails(database, input)
    case 'update-sale-receipt': return updateSaleReceiptDetails(database, input)
    case 'update-sale-bill': return updateSaleBill(database, input)
    case 'restore-backup': return { database: validateBackup(input.backup || input), record: { restored: true } }
    default: throw new Error(`Unknown database command: ${command}`)
  }
}

export function processCustomerReturn(database, input) {
  const sale = database.sales.find((entry) => entry.id === input.saleId)
  if (!sale) throw new Error('Choose the original sale for this return.')
  const originalItem = input.lineId ? sale.items.find((item) => item.lineId === input.lineId) : sale.items.find((item) => item.productId === input.productId || item.code === input.code || item.name.toLowerCase() === String(input.code || input.name || '').toLowerCase())
  if (!originalItem) throw new Error('That item is not on the selected sale.')
  const quantity = positiveQuantity(input.quantity)
  const returnKey = originalItem.lineId || originalItem.productId
  const alreadyReturned = database.returns.filter((entry) => entry.saleId === sale.id && (entry.lineId || entry.productId) === returnKey).reduce((sum, entry) => sum + entry.quantity, 0)
  const soldQuantity = originalItem.lineId ? originalItem.quantity : sale.items.filter((item) => item.productId === originalItem.productId).reduce((sum, item) => sum + item.quantity, 0)
  if (alreadyReturned + quantity > soldQuantity) throw new Error('Return quantity exceeds the amount sold and not yet returned.')
  const amount = quantity * originalItem.unitPrice
  const condition = input.condition || 'sellable'
  const result = record('return', { saleId: sale.id, saleNumber: sale.number, customerId: sale.customerId, productId: originalItem.productId, lineId: originalItem.lineId, code: originalItem.code, itemName: originalItem.name, quantity, unitPrice: originalItem.unitPrice, unitCostAtSale: Number(originalItem.unitCostAtSale || 0), amount, condition, refundType: input.refundType || 'khata', date: dateOf(input.date) })
  let products = database.products
  let stockMovements = database.stockMovements
  if (condition === 'sellable' || condition === 'Sellable stock') {
    products = products.map((product) => product.id === originalItem.productId ? { ...product, stockQuantity: Number(product.stockQuantity || 0) + quantity } : product)
    stockMovements = addMovement({ ...database, stockMovements }, { productId: originalItem.productId, type: 'customer-return', quantity, referenceId: result.id, date: result.date, note: sale.number })
  } else {
    products = products.map((product) => product.id === originalItem.productId ? { ...product, defectiveQuantity: Number(product.defectiveQuantity || 0) + quantity } : product)
    stockMovements = addMovement({ ...database, stockMovements }, { productId: originalItem.productId, type: 'customer-return-defective', quantity, referenceId: result.id, date: result.date, note: sale.number })
  }
  const customers = sale.customerId && result.refundType === 'khata' ? updateBalance(database.customers, sale.customerId, -amount) : database.customers
  let next = { ...database, products, customers, returns: [result, ...database.returns], stockMovements }
  if (result.refundType === 'cash') next = { ...next, payments: addPayment(next, { type: 'customer-refund', method: 'cash', amount, customerId: sale.customerId, referenceId: result.id, date: result.date }) }
  next = { ...next, auditHistory: addAudit(next, 'customer-return', result.id, `Return linked to ${sale.number || sale.id}`) }
  return { database: next, record: result }
}

export function processSupplierReturn(database, input) {
  const purchase = database.purchases.find((entry) => entry.id === input.purchaseId)
  if (!purchase) throw new Error('Choose the original purchase for this supplier return.')
  const originalItem = input.purchaseItemId ? purchase.items.find((item) => item.lineId === input.purchaseItemId) : purchase.items.find((item) => item.productId === input.productId || item.code === input.code)
  if (!originalItem) throw new Error('That item is not on the selected purchase.')
  const quantity = positiveQuantity(input.quantity)
  const returnKey = originalItem.lineId || originalItem.productId
  const alreadyReturned = database.supplierReturns.filter((entry) => entry.purchaseId === purchase.id && (entry.purchaseItemId || entry.productId) === returnKey).reduce((sum, entry) => sum + entry.quantity, 0)
  const receivedQuantity = originalItem.lineId ? originalItem.quantity : purchase.items.filter((item) => item.productId === originalItem.productId).reduce((sum, item) => sum + item.quantity, 0)
  if (alreadyReturned + quantity > receivedQuantity) throw new Error('Return quantity exceeds the amount received and not yet returned.')
  const product = database.products.find((entry) => entry.id === originalItem.productId)
  if (!product || Number(product.stockQuantity || 0) - Number(product.reservedQuantity || 0) < quantity) throw new Error('There is not enough unreserved stock to return this item.')
  const result = record('supplier-return', { purchaseId: purchase.id, purchaseItemId: originalItem.lineId, supplierId: purchase.supplierId, productId: product.id, code: originalItem.code, itemName: originalItem.productName, quantity, amount: quantity * originalItem.unitCost, date: dateOf(input.date), reason: input.reason || '' })
  const products = database.products.map((entry) => entry.id === product.id ? { ...entry, stockQuantity: Number(entry.stockQuantity) - quantity } : entry)
  const suppliers = updateBalance(database.suppliers, purchase.supplierId, -result.amount)
  result.batchNumber = receivingLabel(purchase)
  const stockMovements = addMovement(database, { productId: product.id, type: 'supplier-return', quantity: -quantity, referenceId: result.id, date: result.date, note: `${result.batchNumber}${input.reason ? ` · ${input.reason}` : ''}` })
  const next = { ...database, products, suppliers, supplierReturns: [result, ...database.supplierReturns], stockMovements, auditHistory: addAudit(database, 'supplier-return', result.id, `Return linked to receiving ${result.batchNumber}`) }
  return { database: next, record: result }
}

export function recordAccountPayment(database, input) {
  const amount = amountOf(input.amount)
  if (!amount) throw new Error('Payment amount must be greater than zero.')
  const isCustomer = input.accountType === 'customer'
  if (!isCustomer && input.accountType !== 'supplier') throw new Error('Account type must be customer or supplier.')
  const accountRows = isCustomer ? database.customers : database.suppliers
  const account = accountRows.find((entry) => entry.id === input.accountId)
  if (!account) throw new Error(`The ${input.accountType} account could not be found.`)
  const method = input.method || 'cash'
  if (!['cash', 'bank', 'cheque'].includes(method)) throw new Error('Payment method must be cash, bank, or cheque.')
  const payment = record('payment', { type: isCustomer ? 'customer-payment' : 'supplier-payment', accountType: input.accountType, method, amount, customerId: isCustomer ? account.id : undefined, supplierId: isCustomer ? undefined : account.id, referenceId: input.referenceId || '', date: dateOf(input.date), note: input.note || '' })
  const rows = method === 'cheque' ? accountRows : updateBalance(accountRows, account.id, -amount)
  let next = { ...database, [isCustomer ? 'customers' : 'suppliers']: rows, payments: method === 'cheque' ? database.payments : [payment, ...database.payments] }
  if (method === 'cheque') next = { ...next, cheques: [record('cheque', { direction: isCustomer ? 'received' : 'given', partyType: input.accountType, partyId: account.id, party: account.name, amount, number: input.cheque?.number || '', issued: dateOf(input.date), bank: input.cheque?.bank || '', referenceId: payment.id, status: 'Pending' }), ...next.cheques] }
  next = { ...next, auditHistory: addAudit(next, payment.type, payment.id, `${input.accountType} payment recorded`) }
  return { database: next, record: payment }
}

export function recordExpense(database, input) {
  const amount = amountOf(input.amount)
  if (amount <= 0) throw new Error('Expense amount must be greater than zero.')
  const method = input.method || 'cash'
  const expense = record('expense', { category: input.category || 'Other', amount, date: dateOf(input.date), description: input.description || '', paidTo: input.paidTo || '', method, account: input.account || method })
  const next = { ...database, expenses: [expense, ...database.expenses], auditHistory: addAudit(database, 'expense', expense.id, `${expense.category} expense recorded`) }
  return { database: next, record: expense }
}

export function updateChequeStatus(database, chequeId, status, options = {}) {
  const allowedStatuses = ['Pending', 'Deposited / Presented', 'Under Clearing', 'Cleared', 'Returned', 'Cancelled', 'Bounced', 'Bounced / Dishonoured', 'Rescheduled', 'Replaced']
  if (!allowedStatuses.includes(status)) throw new Error('Choose a valid cheque transaction status.')
  const cheque = database.cheques.find((entry) => entry.id === chequeId)
  if (!cheque) throw new Error('Cheque could not be found.')
  if (cheque.status === status) return { database, record: cheque }
  const previousStatus = cheque.status || 'Pending'
  const pendingStatuses = ['Pending', 'Deposited / Presented', 'Under Clearing', 'Rescheduled']
  const bounced = ['Returned', 'Bounced', 'Bounced / Dishonoured'].includes(status)
  if (status === 'Cancelled' && !pendingStatuses.includes(previousStatus)) throw new Error('Only unresolved cheques can be cancelled.')
  if (status === 'Cleared' && !pendingStatuses.includes(previousStatus)) throw new Error(`Cannot clear a ${previousStatus.toLowerCase()} cheque.`)
  if (bounced && !pendingStatuses.includes(previousStatus) && previousStatus !== 'Cleared') throw new Error(`Cannot bounce a ${previousStatus.toLowerCase()} cheque.`)
  const timestamp = now()
  const historyEntry = {
    previousStatus,
    status,
    date: timestamp,
    userId: String(options.actor?._id || ''),
    userName: options.actor?.name || '',
    remarks: String(options.remarks || '').trim(),
  }
  const updated = {
    ...cheque,
    status,
    statusHistory: [...(cheque.statusHistory || []), historyEntry],
    ...(status === 'Cleared' ? { clearedAt: timestamp, actualClearanceDate: dateOf() } : {}),
    ...(status === 'Cancelled' ? { cancelledAt: timestamp } : {}),
    ...(bounced ? {
      bounceDate: options.bounceDate || dateOf(),
      bounceReason: String(options.bounceReason || options.remarks || '').trim(),
      bankCharges: Number(options.bankCharges || 0),
    } : {}),
  }
  let next = { ...database, cheques: database.cheques.map((entry) => entry.id === chequeId ? updated : entry) }
  if (status === 'Cleared' && !cheque.appliedToBalance) {
    if (cheque.partyType === 'customer' && cheque.partyId) next = { ...next, customers: updateBalance(next.customers, cheque.partyId, -Number(cheque.amount || 0)) }
    if (cheque.partyType === 'supplier' && cheque.partyId) next = { ...next, suppliers: updateBalance(next.suppliers, cheque.partyId, -Number(cheque.amount || 0)) }
    next = { ...next, cheques: next.cheques.map((entry) => entry.id === chequeId ? { ...entry, appliedToBalance: true } : entry), payments: addPayment(next, { type: cheque.partyType === 'customer' ? 'customer-payment' : 'supplier-payment', method: 'cheque-cleared', amount: cheque.amount, customerId: cheque.partyType === 'customer' ? cheque.partyId : undefined, supplierId: cheque.partyType === 'supplier' ? cheque.partyId : undefined, referenceId: cheque.referenceId, date: dateOf() }) }
  }
  if (bounced && cheque.status === 'Cleared' && cheque.appliedToBalance) {
    if (cheque.partyType === 'customer' && cheque.partyId) next = { ...next, customers: updateBalance(next.customers, cheque.partyId, Number(cheque.amount || 0)) }
    if (cheque.partyType === 'supplier' && cheque.partyId) next = { ...next, suppliers: updateBalance(next.suppliers, cheque.partyId, Number(cheque.amount || 0)) }
    next = { ...next, cheques: next.cheques.map((entry) => entry.id === chequeId ? { ...entry, appliedToBalance: false } : entry), payments: addPayment(next, { type: 'cheque-reversal', method: 'cheque-returned', amount: cheque.amount, customerId: cheque.partyType === 'customer' ? cheque.partyId : undefined, supplierId: cheque.partyType === 'supplier' ? cheque.partyId : undefined, referenceId: cheque.referenceId, date: dateOf() }) }
  }
  const auditHistory = [...next.auditHistory, record('audit', { type: 'cheque-status', referenceId: cheque.id, description: `Cheque marked ${status.toLowerCase()}${historyEntry.remarks ? `: ${historyEntry.remarks}` : ''}`, date: timestamp, userId: historyEntry.userId, userName: historyEntry.userName })]
  next = { ...next, auditHistory }
  return { database: next, record: next.cheques.find((entry) => entry.id === chequeId) }
}

export function updateChequeDetails(database, input, actor = null) {
  const cheque = database.cheques.find((entry) => entry.id === input.chequeId)
  if (!cheque) throw new Error('Cheque could not be found.')
  const dueDate = String(input.expectedClearanceDate ?? cheque.expectedClearanceDate ?? '').slice(0, 10)
  if (dueDate && Number.isNaN(Date.parse(`${dueDate}T00:00:00Z`))) throw new Error('Enter a valid expected clearance date.')
  const oldDate = cheque.expectedClearanceDate || ''
  const changedDate = dueDate !== oldDate
  const remark = String(input.remarks || '').trim()
  if (changedDate && !remark) throw new Error('Enter a reason when rescheduling a cheque.')
  const timestamp = now()
  const updated = {
    ...cheque,
    expectedClearanceDate: dueDate,
    notes: input.notes == null ? cheque.notes || '' : String(input.notes).trim(),
    followUpNote: input.followUpNote == null ? cheque.followUpNote || '' : String(input.followUpNote).trim(),
    ...(changedDate ? {
      status: ['Pending', 'Deposited / Presented', 'Under Clearing'].includes(cheque.status) ? 'Rescheduled' : cheque.status,
      rescheduleCount: Number(cheque.rescheduleCount || 0) + 1,
      rescheduleHistory: [...(cheque.rescheduleHistory || []), { previousDate: oldDate, updatedDate: dueDate, date: timestamp, reason: remark, userId: String(actor?._id || ''), userName: actor?.name || '' }],
      statusHistory: [...(cheque.statusHistory || []), { previousStatus: cheque.status || 'Pending', status: 'Rescheduled', date: timestamp, userId: String(actor?._id || ''), userName: actor?.name || '', remarks: remark }],
    } : {}),
  }
  const next = { ...database, cheques: database.cheques.map((entry) => entry.id === cheque.id ? updated : entry), auditHistory: [...database.auditHistory, record('audit', { type: changedDate ? 'cheque-rescheduled' : 'cheque-follow-up', referenceId: cheque.id, description: changedDate ? `Cheque rescheduled from ${oldDate} to ${dueDate}: ${remark}` : `Cheque follow-up updated${remark ? `: ${remark}` : ''}`, date: timestamp, userId: String(actor?._id || ''), userName: actor?.name || '' })] }
  return { database: next, record: updated }
}

export function recordHeldOrder(database, input) {
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('A held order must contain at least one item.')
  const kind = String(input.kind || input.orderKind || 'held')
  if (!['held', 'draft', 'quotation', 'reservation'].includes(kind)) throw new Error('Order kind must be held, draft, quotation, or reservation.')
  const items = input.items.map((item) => {
    const quantity = positiveQuantity(item.quantity)
    if (item.isReturn || item.returnQuantity) return { ...item, lineId: item.lineId || makeId('held-line'), quantity, remainingQuantity: quantity }
    const product = getProduct(database.products, item)
    return { ...item, lineId: item.lineId || makeId('held-line'), productId: product.id, name: product.name, code: product.code, quantity, remainingQuantity: quantity }
  })
  const reservesStock = kind !== 'quotation'
  const held = record('held', { ...input, items, kind, status: 'held', date: dateOf(input.date) })
  const products = reservesStock ? database.products.map((product) => {
    const heldQuantity = items.filter((item) => !item.isReturn && !item.returnQuantity && item.productId === product.id).reduce((sum, item) => sum + item.quantity, 0)
    if (!heldQuantity) return product
    if (Number(product.stockQuantity || 0) - Number(product.reservedQuantity || 0) < heldQuantity) throw new Error(`Not enough stock to reserve ${product.name}.`)
    return { ...product, reservedQuantity: Number(product.reservedQuantity || 0) + heldQuantity }
  }) : database.products
  const next = { ...database, products, heldOrders: [held, ...database.heldOrders], auditHistory: addAudit(database, 'held-order', held.id, kind === 'quotation' ? 'Quotation saved' : 'Order held and stock reserved') }
  return { database: next, record: held }
}

export function releaseHeldOrder(database, heldId, disposition = 'resumed') {
  const held = database.heldOrders.find((entry) => entry.id === heldId)
  if (!held) throw new Error('Held order could not be found.')
  const products = held.kind === 'quotation' ? database.products : database.products.map((product) => {
    const quantity = held.items.filter((item) => !item.isReturn && !item.returnQuantity && (item.productId ? item.productId === product.id : legacyHeldItemMatches(database.products, item, product))).reduce((sum, item) => sum + Number(item.remainingQuantity ?? item.quantity), 0)
    return quantity ? { ...product, reservedQuantity: Math.max(0, Number(product.reservedQuantity || 0) - quantity) } : product
  })
  const next = { ...database, products, heldOrders: database.heldOrders.filter((entry) => entry.id !== heldId), auditHistory: addAudit(database, `held-order-${disposition}`, held.id, `Held order ${disposition}`) }
  return { database: next, record: held }
}

function legacyHeldItemMatches(products, item, product) {
  const code = String(item.code || '').trim().toLowerCase()
  if (code) {
    const matches = products.filter((entry) => entry.code?.trim().toLowerCase() === code)
    return matches.length === 1 && matches[0].id === product.id
  }
  const name = String(item.name || '').trim().toLowerCase()
  const matches = products.filter((entry) => entry.name?.trim().toLowerCase() === name)
  return matches.length === 1 && matches[0].id === product.id
}

export function calculateDailyClosing(database, date) {
  const dateOnly = (value) => String(value || '').slice(0, 10)
  const sameDate = (entry) => dateOnly(entry.date) === date
  const opening = database.dailyClosings.find((entry) => entry.type === 'opening' && sameDate(entry))?.amount || 0
  const sumPayment = (predicate) => database.payments.filter((entry) => sameDate(entry) && predicate(entry)).reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const salesOnDate = database.sales.filter((sale) => dateOnly(sale.date) === date)
  const salePaymentTotal = (method) => salesOnDate.reduce((sum, sale) => {
    const payments = sale.payments || {}
    return sum + (method === 'bank' ? Number(payments.bank ?? payments.bankTransfer ?? 0) : Number(payments[method] || 0))
  }, 0)
  const linkedSalePaymentTotal = (method) => sumPayment((entry) => entry.type === 'customer-payment' && entry.method === method && salesOnDate.some((sale) => sale.id === entry.referenceId && !sale.payments))
  const cashSales = salePaymentTotal('cash') + linkedSalePaymentTotal('cash')
  const bankSales = salePaymentTotal('bank') + linkedSalePaymentTotal('bank')
  const chequeSales = salePaymentTotal('cheque') + linkedSalePaymentTotal('cheque')
  const creditSales = salesOnDate.reduce((sum, sale) => sum + Number(sale.payments?.credit ?? sale.payments?.khata ?? Math.max(0, Number(sale.total || 0) - Number(sale.payments?.cash || 0) - Number(sale.payments?.bank || sale.payments?.bankTransfer || 0) - Number(sale.payments?.cheque || 0))), 0)
  const customerPayments = sumPayment((entry) => entry.type === 'customer-payment' && entry.method === 'cash' && !database.sales.some((sale) => sale.id === entry.referenceId))
  const supplierPayments = sumPayment((entry) => entry.type === 'supplier-payment' && entry.method === 'cash')
  const expensesOnDate = database.expenses.filter(sameDate)
  const expenseTotal = expensesOnDate.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const cashExpenses = expensesOnDate.filter((entry) => entry.method === 'cash').reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const bankExpenses = expensesOnDate.filter((entry) => entry.method === 'bank').reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const chequeExpenses = expensesOnDate.filter((entry) => entry.method === 'cheque').reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const cashRefunds = sumPayment((entry) => entry.type === 'customer-refund' && entry.method === 'cash')
  const cashOtherReceipts = (database.financeEntries || []).filter((entry) => sameDate(entry) && entry.type === 'capital' && entry.method === 'cash').reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const bankTransactions = (database.bankTransactions || []).filter((entry) => sameDate(entry))
  const cashWithdrawals = bankTransactions.filter((entry) => entry.type === 'withdrawal' && entry.destination === 'cash').reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const cashDeposits = bankTransactions.filter((entry) => entry.type === 'deposit' && entry.source === 'cash').reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const expectedCash = money(opening + cashSales + customerPayments + cashOtherReceipts + cashWithdrawals - supplierPayments - cashExpenses - cashRefunds - cashDeposits)
  return { date, opening, cashSales, bankSales, chequeSales, creditSales, customerPayments, cashOtherReceipts, supplierPayments, expenseTotal, cashExpenses, bankExpenses, chequeExpenses, cashRefunds, cashWithdrawals, cashDeposits, expectedCash }
}

export function calculateBankBalanceSummary(database, date) {
  const accounts = database.bankAccounts || []
  const transactions = database.bankTransactions || []
  const records = database.bankBalanceRecords || []
  const rows = accounts.map((account) => {
    const accountRecords = records.filter((entry) => entry.accountId === account.id && entry.date < date)
      .sort((left, right) => right.date.localeCompare(left.date) || String(right.createdAt).localeCompare(String(left.createdAt)))
    const previous = accountRecords[0] || null
    const baseline = Number(previous?.closingBalance ?? account.openingBalance ?? 0)
    const fromDate = previous?.date || ''
    let expectedBalance = baseline
    for (const transaction of transactions) {
      if (transaction.date > date || transaction.date <= fromDate) continue
      const amount = Number(transaction.amount || 0)
      if (transaction.accountId === account.id) {
        if (transaction.type === 'withdrawal' || transaction.type === 'transfer') expectedBalance -= amount
        if (transaction.type === 'deposit') expectedBalance += amount
      }
      if (['transfer', 'withdrawal'].includes(transaction.type) && transaction.destination === 'account' && transaction.destinationAccountId === account.id) expectedBalance += amount
    }
    expectedBalance = money(expectedBalance)
    const dayRecord = records.filter((entry) => entry.accountId === account.id && entry.date === date)
      .sort((left, right) => Number(right.revision || 0) - Number(left.revision || 0) || String(right.createdAt).localeCompare(String(left.createdAt)))[0]
    const currentBalance = Number(dayRecord?.closingBalance ?? expectedBalance)
    return {
      accountId: account.id,
      name: account.name,
      active: account.active !== false,
      previousBalance: money(previous?.closingBalance ?? account.openingBalance ?? 0),
      expectedBalance,
      currentBalance: money(currentBalance),
      difference: dayRecord ? money(currentBalance - Number(dayRecord.expectedBalance ?? expectedBalance)) : 0,
      note: dayRecord?.note || '',
      lastUpdatedAt: dayRecord?.createdAt || null,
    }
  })
  return {
    date,
    accounts: rows,
    previousTotal: money(rows.filter((row) => row.active).reduce((sum, row) => sum + row.previousBalance, 0)),
    expectedTotal: money(rows.filter((row) => row.active).reduce((sum, row) => sum + row.expectedBalance, 0)),
    currentTotal: money(rows.filter((row) => row.active).reduce((sum, row) => sum + row.currentBalance, 0)),
  }
}

export function createBankAccount(database, input, actor = null) {
  const name = String(input.name || '').trim()
  if (!name) throw new Error('Enter a bank or wallet name.')
  if ((database.bankAccounts || []).some((entry) => entry.name.toLowerCase() === name.toLowerCase())) throw new Error('A bank account with this name already exists.')
  const account = record('bank-account', { name, openingBalance: money(amountOf(input.openingBalance ?? 0)), active: true, createdById: String(actor?._id || ''), createdByName: actor?.name || '' })
  const next = { ...database, bankAccounts: [account, ...(database.bankAccounts || [])], auditHistory: addAudit(database, 'bank-account-created', account.id, `Bank account ${name} created`) }
  return { database: next, record: account }
}

export function updateBankAccount(database, input, actor = null) {
  const account = (database.bankAccounts || []).find((entry) => entry.id === input.accountId)
  if (!account) throw new Error('Bank account could not be found.')
  const name = input.name == null ? account.name : String(input.name).trim()
  if (!name) throw new Error('Enter a bank or wallet name.')
  if ((database.bankAccounts || []).some((entry) => entry.id !== account.id && entry.name.toLowerCase() === name.toLowerCase())) throw new Error('A bank account with this name already exists.')
  const updated = { ...account, name, active: input.active == null ? account.active !== false : Boolean(input.active), updatedAt: now(), updatedById: String(actor?._id || ''), updatedByName: actor?.name || '' }
  const next = { ...database, bankAccounts: database.bankAccounts.map((entry) => entry.id === account.id ? updated : entry), auditHistory: addAudit(database, 'bank-account-updated', account.id, `Bank account ${name} updated`) }
  return { database: next, record: updated }
}

export function recordBankTransaction(database, input, actor = null) {
  const type = input.type
  if (!['withdrawal', 'deposit', 'transfer'].includes(type)) throw new Error('Bank transaction must be a withdrawal, deposit, or transfer.')
  const amount = money(amountOf(input.amount))
  if (amount <= 0) throw new Error('Enter an amount greater than zero.')
  const transactionDate = dateOf(input.date)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(transactionDate) || Number.isNaN(Date.parse(`${transactionDate}T00:00:00Z`))) throw new Error('Enter a valid transaction date.')
  const account = (database.bankAccounts || []).find((entry) => entry.id === input.accountId && entry.active !== false)
  if (!account) throw new Error('Select an active bank account.')
  const destinationAccount = input.destinationAccountId
    ? database.bankAccounts.find((entry) => entry.id === input.destinationAccountId && entry.active !== false)
    : null
  if (type === 'transfer' && (!destinationAccount || destinationAccount.id === account.id)) throw new Error('Choose a different active destination bank account.')
  if (type === 'withdrawal' && input.destination === 'account' && (!destinationAccount || destinationAccount.id === account.id)) throw new Error('Choose a different active destination account.')
  const transaction = record('bank-transaction', {
    type,
    accountId: account.id,
    destinationAccountId: destinationAccount?.id || '',
    source: type === 'deposit' ? 'cash' : 'bank',
    destination: type === 'withdrawal' ? (input.destination === 'account' ? 'account' : 'cash') : type === 'transfer' ? 'account' : 'bank',
    amount,
    date: transactionDate,
    reference: String(input.reference || '').trim(),
    note: String(input.note || '').trim(),
    responsibleUserId: String(actor?._id || ''),
    responsibleUserName: actor?.name || '',
  })
  const next = { ...database, bankTransactions: [transaction, ...(database.bankTransactions || [])], auditHistory: addAudit(database, 'bank-transaction', transaction.id, `${type} of Rs. ${amount} from ${account.name} recorded`) }
  return { database: next, record: transaction }
}

export function saveBankBalances(database, input, actor = null) {
  const date = dateOf(input.date)
  if (!Array.isArray(input.balances) || !input.balances.length) throw new Error('Enter at least one bank closing balance.')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new Error('Enter a valid bank closing date.')
  const records = [...(database.bankBalanceRecords || [])]
  const createdAt = now()
  for (const entry of input.balances) {
    const account = database.bankAccounts.find((row) => row.id === entry.accountId && row.active !== false)
    if (!account) throw new Error('A selected bank account is missing or inactive.')
    if (entry.closingBalance == null || entry.closingBalance === '' || !Number.isFinite(Number(entry.closingBalance))) throw new Error(`Enter a valid closing balance for ${account.name}.`)
    const closingBalance = money(amountOf(entry.closingBalance))
    const summary = calculateBankBalanceSummary({ ...database, bankBalanceRecords: records }, date)
    const expectedBalance = summary.accounts.find((row) => row.accountId === account.id)?.expectedBalance ?? Number(account.openingBalance || 0)
    const revision = records.filter((row) => row.accountId === account.id && row.date === date).reduce((highest, row) => Math.max(highest, Number(row.revision || 0)), 0) + 1
    records.unshift(record('bank-balance', {
      accountId: account.id,
      accountName: account.name,
      date,
      closingBalance,
      previousBalance: summary.accounts.find((row) => row.accountId === account.id)?.previousBalance || 0,
      expectedBalance,
      difference: money(closingBalance - expectedBalance),
      note: String(entry.note || '').trim(),
      revision,
      createdAt,
      responsibleUserId: actor?.id || '',
      responsibleUserName: actor?.name || '',
    }))
  }
  const next = { ...database, bankBalanceRecords: records, auditHistory: addAudit(database, 'bank-balances-saved', date, `Bank closing balances saved for ${date}`) }
  return { database: next, record: records.filter((entry) => entry.date === date && entry.createdAt === createdAt) }
}

export function financialPeriodDatabase(database, from = '', to = '') {
  const inRange = (value) => { const date = String(value || '').slice(0, 10); return (!from || date >= from) && (!to || date <= to) }
  const byId = new Map(database.sales.map(sale => [sale.id, sale]))
  return { ...database,
    sales: database.sales.filter(sale => inRange(sale.date)).map(sale => ({ ...sale, total: Number(sale.total ?? sale.totalAmount ?? 0) + Number(sale.returnTotal || 0), returnTotal: 0, items: (sale.items || []).filter(item => !item.isReturn) })),
    returns: database.returns.filter(entry => inRange(byId.get(entry.saleId)?.date || entry.saleDate || entry.date)).map(entry => {
      const item = byId.get(entry.saleId)?.items?.find(item => entry.lineId ? item.lineId === entry.lineId : item.productId === entry.productId)
      return { ...entry, refundType: entry.refundType === 'sale-adjustment' ? 'financial-adjustment' : entry.refundType, unitCostAtSale: entry.unitCostAtSale ?? item?.unitCostAtSale ?? item?.costPrice ?? 0 }
    }),
    expenses: database.expenses.filter(entry => inRange(entry.date)),
  }
}

export function calculateBusinessTotals(database) {
  const getGrossBilled = (sale) => Number(sale.subtotal ?? (sale.items || []).filter((item) => !item.isReturn).reduce((sum, item) => sum + Number(item.lineTotal ?? Number(item.quantity || 0) * Number(item.unitPrice ?? item.price ?? 0)), 0))
  const getDiscount = (sale) => Number(sale.discount || 0)
  const getBillReturns = (sale) => Number(sale.returnTotal || 0)
  const getNetBill = (sale) => Number(sale.total ?? sale.totalAmount ?? (getGrossBilled(sale) - getDiscount(sale) - getBillReturns(sale)))
  const grossBilled = database.sales.reduce((sum, sale) => sum + getGrossBilled(sale), 0)
  const discounts = database.sales.reduce((sum, sale) => sum + getDiscount(sale), 0)
  const billReturnAdjustments = database.sales.reduce((sum, sale) => sum + getBillReturns(sale), 0)
  const returnsProcessedSeparately = database.returns.filter((entry) => entry.refundType !== 'sale-adjustment')
  const separateReturnAmount = returnsProcessedSeparately.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const netSales = database.sales.reduce((sum, sale) => sum + getNetBill(sale), 0) - separateReturnAmount
  const billCost = database.sales.reduce((sum, sale) => sum + (sale.items || []).reduce((subtotal, item) => {
    const direction = item.isReturn && item.returnCondition === 'sellable' ? -1 : 1
    return subtotal + direction * Number(item.quantity || 0) * Number(item.unitCostAtSale || 0)
  }, 0), 0)
  const separateSellableReturnCost = returnsProcessedSeparately.filter((entry) => entry.condition === 'sellable' || entry.condition === 'Sellable stock').reduce((sum, entry) => sum + Number(entry.quantity || 0) * Number(entry.unitCostAtSale || 0), 0)
  const costOfGoods = billCost - separateSellableReturnCost
  const expenses = database.expenses.reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  return {
    grossBilled,
    discounts,
    billReturnAdjustments,
    separateReturnAmount,
    netSales,
    costOfGoods,
    estimatedGrossProfit: netSales - costOfGoods,
    expenses,
    estimatedNetResult: netSales - costOfGoods - expenses,
  }
}

export function calculateAccountLedger(database, accountType, accountId) {
  const isCustomer = accountType === 'customer'
  if (!isCustomer && accountType !== 'supplier') throw new Error('Account type must be customer or supplier.')
  const collection = isCustomer ? 'customers' : 'suppliers'
  const account = database[collection].find((entry) => entry.id === accountId)
  if (!account) throw new Error(`The ${accountType} account could not be found.`)
  const entries = [
    ...(Number(account.openingBalance || 0) ? [{ id: `opening-${account.id}`, date: account.createdAt?.slice(0, 10) || '', title: 'Opening balance', amount: Math.abs(Number(account.openingBalance)), direction: Number(account.openingBalance) < 0 ? 'credit' : 'debit' }] : []),
    ...(isCustomer
      ? database.sales.filter((sale) => sale.customerId === account.id).map((sale) => ({ id: sale.id, date: sale.date, title: `Sale ${sale.number || ''}`.trim(), amount: Number(sale.total || 0), direction: 'debit' }))
      : database.purchases.filter((purchase) => purchase.supplierId === account.id).map((purchase) => ({ id: purchase.id, date: purchase.date, title: `Stock purchase · ${receivingLabel(purchase)}`, batchNumber: receivingLabel(purchase), amount: Number(purchase.total || 0), direction: 'debit' }))),
    ...database.payments.filter((payment) => payment[isCustomer ? 'customerId' : 'supplierId'] === account.id).map((payment) => ({ id: payment.id, date: payment.date, title: `${payment.method} ${payment.type === 'cheque-reversal' ? 'returned' : 'payment'}`, amount: Number(payment.amount || 0), direction: payment.type === 'cheque-reversal' ? 'debit' : 'credit' })),
    ...(isCustomer
      ? database.returns.filter((entry) => entry.customerId === account.id && entry.refundType !== 'sale-adjustment').map((entry) => ({ id: entry.id, date: entry.date, title: entry.refundType === 'cash' ? `Cash refund · ${entry.itemName}` : `Khata return · ${entry.itemName}`, amount: Number(entry.amount || 0), direction: entry.refundType === 'cash' ? 'memo' : 'credit' }))
      : database.supplierReturns.filter((entry) => entry.supplierId === account.id).map((entry) => ({ id: entry.id, date: entry.date, title: `Return · ${entry.itemName}`, amount: Number(entry.amount || 0), direction: 'credit' }))),
    ...(!isCustomer ? database.claims.filter((claim) => claim.supplierId === account.id && claim.status === 'Approved').map((claim) => ({ id: claim.id, date: claim.date, title: 'Approved defect claim', amount: Number(claim.amount || 0), direction: 'credit' })) : []),
  ].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
  const calculatedBalance = entries.reduce((balance, entry) => balance + (entry.direction === 'debit' ? entry.amount : entry.direction === 'credit' ? -entry.amount : 0), 0)
  return { entries, calculatedBalance, storedBalance: Number(account.balance || 0) }
}

export function validateBackup(data) {
  const currentFormat = data?.version === APP_DB_VERSION
  if (data && data.version == null && Array.isArray(data.customers) && Array.isArray(data.savedBills) && Array.isArray(data.heldBills)) {
    const legacy = createEmptyDatabase()
    legacy.customers = data.customers.map((customer, index) => ({ ...customer, id: String(customer.id || `legacy-customer-${index + 1}`), openingBalance: Number(customer.openingBalance || 0), balance: Number(customer.balance ?? customer.openingBalance ?? 0) }))
    legacy.sales = data.savedBills.map((bill, index) => ({ ...bill, id: String(bill.id || `legacy-sale-${index + 1}`), items: (bill.items || []).map((item, lineIndex) => ({ ...item, lineId: String(item.lineId || item.id || `legacy-line-${index + 1}-${lineIndex + 1}`), price: Number(item.price ?? item.unitPrice ?? 0), unitPrice: Number(item.unitPrice ?? item.price ?? 0) })) }))
    legacy.heldOrders = data.heldBills.map((bill, index) => ({ ...bill, id: String(bill.id || `legacy-held-${index + 1}`), status: 'held', items: (bill.items || []).map((item, lineIndex) => ({ ...item, lineId: String(item.lineId || item.id || `legacy-held-line-${index + 1}-${lineIndex + 1}`) })) }))
    data = legacy
  }
  if (data?.version === 1) {
    data = {
      ...data,
      version: APP_DB_VERSION,
      sales: (data.sales || []).map((sale) => ({ ...sale, items: (sale.items || []).map((item, index) => ({ ...item, lineId: item.lineId || item.id || `migrated-${sale.id}-${index}`, unitPrice: Number(item.unitPrice ?? item.price ?? 0), price: Number(item.price ?? item.unitPrice ?? 0), unitCostAtSale: Number(item.unitCostAtSale || 0) })) })),
      purchases: (data.purchases || []).map((purchase) => ({ ...purchase, items: (purchase.items || []).map((item, index) => ({ ...item, lineId: item.lineId || `migrated-${purchase.id}-${index}` })) })),
    }
  }
  if (!data || typeof data !== 'object' || data.version !== APP_DB_VERSION) throw new Error('Unsupported or invalid application backup.')
  const database = createEmptyDatabase()
  const additiveCollections = new Set(['bankAccounts', 'bankTransactions', 'bankBalanceRecords'])
  for (const key of Object.keys(database)) {
    if (Array.isArray(database[key])) {
      if (!Array.isArray(data[key]) && !additiveCollections.has(key)) throw new Error(`Backup is missing a valid ${key} collection.`)
      const rows = data[key] || []
      const ids = new Set()
      for (const item of rows) {
        if (!item || typeof item !== 'object' || !item.id || ids.has(item.id)) throw new Error(`The ${key} collection contains an invalid or duplicate ID.`)
        ids.add(item.id)
      }
      database[key] = rows
    } else if (key === 'version') {
      database.version = APP_DB_VERSION
    } else if (data[key] && typeof data[key] === 'object' && !Array.isArray(data[key])) {
      database[key] = data[key]
    }
  }
  if (currentFormat) validateRelationships(database)
  return database
}

function validateRelationships(database) {
  const assertReference = (collection, id, description) => {
    if (id && !database[collection].some((entry) => entry.id === id)) throw new Error(`Backup contains a ${description} linked to a missing record.`)
  }
  for (const sale of database.sales) {
    assertReference('customers', sale.customerId, 'sale/customer relationship')
    for (const item of sale.items || []) assertReference('products', item.productId, 'sale item/product relationship')
  }
  for (const purchase of database.purchases) {
    assertReference('suppliers', purchase.supplierId, 'purchase/supplier relationship')
    for (const item of purchase.items || []) {
      assertReference('products', item.productId, 'purchase item/product relationship')
      if (purchase.batchNumber && !item.batchNumber) throw new Error('Receiving items must retain their assigned Batch Number.')
    }
  }
  for (const product of database.products) {
    if (!product.purchaseId) continue
    assertReference('purchases', product.purchaseId, 'stock/receiving relationship')
    const purchase = database.purchases.find((entry) => entry.id === product.purchaseId)
    const linkedItemBatch = (purchase.items || []).some((item) => item.productId === product.id && item.batchNumber === product.batchNumber)
    if (purchase.batchNumber && product.batchNumber !== purchase.batchNumber && !linkedItemBatch) throw new Error('Received stock must retain its bill or item Batch Number.')
  }
  for (const entry of database.returns) {
    assertReference('sales', entry.saleId, 'customer return/sale relationship')
    assertReference('sales', entry.adjustmentSaleId, 'customer return/adjustment relationship')
    assertReference('products', entry.productId, 'customer return/product relationship')
  }
  for (const entry of database.supplierReturns) {
    assertReference('purchases', entry.purchaseId, 'supplier return/purchase relationship')
    assertReference('suppliers', entry.supplierId, 'supplier return/supplier relationship')
    assertReference('products', entry.productId, 'supplier return/product relationship')
  }
  for (const entry of database.payments) {
    assertReference('customers', entry.customerId, 'payment/customer relationship')
    assertReference('suppliers', entry.supplierId, 'payment/supplier relationship')
  }
  for (const entry of database.cheques) {
    assertReference(entry.partyType === 'supplier' ? 'suppliers' : 'customers', entry.partyId, 'cheque/account relationship')
  }
  for (const entry of database.stockMovements) assertReference('products', entry.productId, 'stock movement/product relationship')
  for (const entry of database.heldOrders) {
    for (const item of entry.items || []) assertReference('products', item.productId, 'held item/product relationship')
  }
  for (const entry of database.claims) {
    assertReference('products', entry.productId, 'claim/product relationship')
    assertReference('suppliers', entry.supplierId, 'claim/supplier relationship')
  }
  for (const transaction of database.bankTransactions) {
    assertReference('bankAccounts', transaction.accountId, 'bank transaction/account relationship')
    assertReference('bankAccounts', transaction.destinationAccountId, 'bank transfer destination/account relationship')
  }
  for (const balance of database.bankBalanceRecords) assertReference('bankAccounts', balance.accountId, 'bank balance/account relationship')
}

export function createManualCheque(database, input, actor = null) {
  const amount = amountOf(input.amount)
  if (!amount) throw new Error('Cheque amount must be greater than zero.')
  const direction = input.direction === 'given' ? 'given' : 'received'
  const partyType = input.partyType || (direction === 'given' ? 'supplier' : 'customer')
  const collection = partyType === 'supplier' ? 'suppliers' : 'customers'
  const party = database[collection].find((entry) => entry.id === input.partyId)
  if (!party) throw new Error(`The ${partyType} account could not be found.`)
  const cheque = record('cheque', {
    direction,
    partyType,
    partyId: party.id,
    party: party.name,
    amount,
    number: String(input.number || '').trim(),
    bank: String(input.bank || '').trim(),
    issued: dateOf(input.issued || input.date),
    dueDate: input.dueDate || input.expectedClearanceDate || '',
    expectedClearanceDate: input.expectedClearanceDate || '',
    notes: String(input.notes || '').trim(),
    sourceType: input.sourceType || 'manual',
    referenceId: input.referenceId || '',
    status: 'Pending',
    createdById: String(actor?._id || ''),
    createdByName: actor?.name || '',
  })
  const next = { ...database, cheques: [cheque, ...database.cheques], auditHistory: addAudit(database, 'cheque', cheque.id, `Manual ${direction} cheque recorded`) }
  return { database: next, record: cheque }
}

export function updateClaimDetails(database, input) {
  const claim = database.claims.find((entry) => entry.id === input.claimId)
  if (!claim) throw new Error('Claim could not be found.')
  const updated = {
    ...claim,
    dispatchDate: input.dispatchDate ?? claim.dispatchDate ?? '',
    dispatchReference: input.dispatchReference ?? claim.dispatchReference ?? '',
    expectedCreditDate: input.expectedCreditDate ?? claim.expectedCreditDate ?? '',
    physicalStatus: input.physicalStatus ?? claim.physicalStatus ?? 'quarantine',
    financialStatus: input.financialStatus ?? claim.financialStatus ?? 'pending',
    note: input.note ?? claim.note ?? '',
    updatedAt: now(),
  }
  const next = { ...database, claims: database.claims.map((entry) => entry.id === claim.id ? updated : entry), auditHistory: addAudit(database, 'claim-update', claim.id, 'Claim dispatch or credit details updated') }
  return { database: next, record: updated }
}

export function completeHeldOrder(database, input) {
  const released = releaseHeldOrder(database, input.heldId, 'completed')
  const held = released.record
  return createSale(released.database, {
    ...input,
    customerId: input.customerId || held.customerId,
    customer: input.customer || held.customer || '',
    items: input.items || held.items.map((item) => ({ ...item, quantity: Number(item.remainingQuantity ?? item.quantity) })),
    payments: input.payments || held.payments || {},
    discount: input.discount ?? held.discount ?? 0,
    cheque: input.cheque || held.cheque,
    paymentDue: input.paymentDue || held.paymentDue || '',
    number: input.number,
  })
}

export function partialDeliverHeldOrder(database, input) {
  const held = database.heldOrders.find((entry) => entry.id === input.heldId)
  if (!held) throw new Error('Held order could not be found.')
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('Choose at least one remaining quantity to deliver.')
  const deliveredItems = input.items.map((item) => {
    const original = held.items.find((entry) => (item.lineId && entry.lineId === item.lineId) || (item.productId && entry.productId === item.productId) || (item.code && entry.code === item.code))
    if (!original || original.isReturn) throw new Error('A delivery line does not match the held order.')
    const remaining = Number(original.remainingQuantity ?? original.quantity)
    const quantity = positiveQuantity(item.quantity)
    if (quantity > remaining) throw new Error(`Delivery quantity exceeds remaining quantity for ${original.name}.`)
    return { ...original, quantity, price: item.price ?? original.price ?? original.unitPrice }
  })
  const releasedQuantities = deliveredItems.reduce((map, item) => {
    map[item.productId] = (map[item.productId] || 0) + item.quantity
    return map
  }, {})
  const products = held.kind === 'quotation' ? database.products : database.products.map((product) => {
    const quantity = releasedQuantities[product.id] || 0
    return quantity ? { ...product, reservedQuantity: Math.max(0, Number(product.reservedQuantity || 0) - quantity) } : product
  })
  const remainingItems = held.items.map((item) => {
    const delivered = deliveredItems.find((entry) => (item.lineId && entry.lineId === item.lineId) || entry.productId === item.productId)
    if (!delivered) return item
    return { ...item, remainingQuantity: Number(item.remainingQuantity ?? item.quantity) - delivered.quantity }
  }).filter((item) => Number(item.remainingQuantity ?? item.quantity) > 0)
  const working = { ...database, products, heldOrders: remainingItems.length
    ? database.heldOrders.map((entry) => entry.id === held.id ? { ...entry, items: remainingItems, status: 'partial' } : entry)
    : database.heldOrders.filter((entry) => entry.id !== held.id) }
  const saleResult = createSale(working, {
    ...input,
    customerId: input.customerId || held.customerId,
    customer: input.customer || held.customer || '',
    items: deliveredItems,
    payments: input.payments || {},
    discount: input.discount ?? 0,
    cheque: input.cheque,
    paymentDue: input.paymentDue || '',
    number: input.number,
  })
  saleResult.database = { ...saleResult.database, auditHistory: addAudit(saleResult.database, 'held-order-partial', held.id, `Partial delivery from held order ${held.id}`) }
  return { database: saleResult.database, record: { sale: saleResult.record, heldOrder: remainingItems.length ? saleResult.database.heldOrders.find((entry) => entry.id === held.id) : null } }
}

export function recordFinanceEntry(database, input) {
  const amount = amountOf(input.amount)
  if (!amount) throw new Error('Finance amount must be greater than zero.')
  const type = String(input.type || 'expense')
  if (!['expense', 'drawing', 'family-drawing', 'capital', 'transfer'].includes(type)) throw new Error('Finance type must be expense, drawing, family-drawing, capital, or transfer.')
  if (type === 'expense' || type === 'drawing' || type === 'family-drawing') {
    const category = type === 'expense' ? (input.category || 'Other') : type === 'family-drawing' ? 'Family drawing' : 'Personal withdrawal'
    return recordExpense(database, { ...input, category, amount, method: input.method || 'cash' })
  }
  const entry = record('finance', {
    type,
    amount,
    date: dateOf(input.date),
    method: input.method || 'bank',
    fromAccount: input.fromAccount || '',
    toAccount: input.toAccount || '',
    description: input.description || '',
  })
  const next = { ...database, financeEntries: [entry, ...(database.financeEntries || [])], auditHistory: addAudit(database, 'finance', entry.id, `${type} recorded`) }
  return { database: next, record: entry }
}

export function bulkAccountRecovery(database, input) {
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('Add at least one recovery line.')
  const method = input.method || 'cash'
  if (!['cash', 'bank'].includes(method)) throw new Error('Bulk recovery must be cash or bank.')
  const seen = new Set()
  for (const item of input.items) {
    const accountId = item.accountId || item.customerId
    const account = database.customers.find((customer) => customer.id === accountId)
    if (!account) throw new Error('A recovery customer account could not be found.')
    if (seen.has(accountId)) throw new Error(`Duplicate recovery for ${account.name}.`)
    seen.add(accountId)
    const amount = amountOf(item.amount)
    if (amount <= 0) throw new Error(`Recovery for ${account.name} must be greater than zero.`)
    if (amount > Number(account.balance || 0) + 0.005) throw new Error(`Recovery for ${account.name} exceeds the outstanding balance.`)
  }
  let working = database
  const records = []
  for (const item of input.items) {
    const result = recordAccountPayment(working, {
      accountType: 'customer',
      accountId: item.accountId || item.customerId,
      amount: item.amount,
      method,
      date: input.date,
      note: item.note || 'Bulk recovery',
    })
    working = result.database
    records.push(result.record)
  }
  working = { ...working, auditHistory: addAudit(working, 'bulk-recovery', records[0]?.id, `Bulk ${method} recovery of ${records.length} accounts`) }
  return { database: working, record: records }
}

export function createInstallmentPlan(database, input) {
  if (!input.customerId) throw new Error('Choose a customer for the installment plan.')
  const customer = database.customers.find((entry) => entry.id === input.customerId)
  if (!customer) throw new Error('The customer account could not be found.')
  const totalAmount = amountOf(input.totalAmount)
  const installmentCount = positiveQuantity(input.installmentCount)
  const amountEach = Math.round((totalAmount / installmentCount) * 100) / 100
  const startDate = dateOf(input.startDate || input.date)
  const schedule = Array.from({ length: installmentCount }, (_, index) => {
    const due = new Date(`${startDate}T00:00:00`)
    due.setMonth(due.getMonth() + index)
    return { installmentNumber: index + 1, dueDate: localDateString(due), amount: index === installmentCount - 1 ? Math.round((totalAmount - amountEach * (installmentCount - 1)) * 100) / 100 : amountEach, paid: 0, status: 'pending' }
  })
  const plan = record('installment', {
    customerId: customer.id,
    customer: customer.name,
    saleId: input.saleId || '',
    totalAmount,
    installmentCount,
    paidAmount: 0,
    schedule,
    status: 'active',
    date: startDate,
  })
  const next = { ...database, installments: [plan, ...(database.installments || [])], auditHistory: addAudit(database, 'installment', plan.id, `Installment plan created for ${customer.name}`) }
  return { database: next, record: plan }
}

export function receiveInstallmentPayment(database, input) {
  const plan = (database.installments || []).find((entry) => entry.id === input.installmentId)
  if (!plan) throw new Error('Installment plan could not be found.')
  const amount = amountOf(input.amount)
  if (!amount) throw new Error('Installment amount must be greater than zero.')
  let remaining = amount
  const schedule = plan.schedule.map((row) => {
    if (!remaining || row.status === 'paid') return row
    const due = Math.max(0, Number(row.amount) - Number(row.paid || 0))
    const applied = Math.min(due, remaining)
    remaining -= applied
    const paid = Number(row.paid || 0) + applied
    return { ...row, paid, status: paid + 0.005 >= Number(row.amount) ? 'paid' : 'partial' }
  })
  const paidAmount = Number(plan.paidAmount || 0) + amount
  const updated = { ...plan, schedule, paidAmount, status: paidAmount + 0.005 >= Number(plan.totalAmount) ? 'completed' : 'active' }
  const paymentResult = recordAccountPayment(database, {
    accountType: 'customer',
    accountId: plan.customerId,
    amount,
    method: input.method || 'cash',
    date: input.date,
    note: `Installment ${plan.id}`,
    referenceId: plan.id,
  })
  const next = { ...paymentResult.database, installments: (paymentResult.database.installments || []).map((entry) => entry.id === plan.id ? updated : entry) }
  return { database: next, record: updated }
}

export function updateProductDetails(database, input) {
  const product = database.products.find((entry) => entry.id === input.productId)
  if (!product) throw new Error('Product could not be found.')
  const updated = {
    ...product,
    name: input.name == null ? product.name : String(input.name).trim(),
    code: input.code == null ? product.code : String(input.code).trim(),
    article: input.article == null ? product.article : String(input.article).trim(),
    rackLocation: input.rackLocation == null ? product.rackLocation : String(input.rackLocation).trim(),
    salePrice: input.salePrice == null ? product.salePrice : amountOf(input.salePrice),
    averageCost: input.averageCost == null ? product.averageCost : amountOf(input.averageCost),
    labels: input.labels == null ? product.labels || [] : input.labels,
    active: input.active == null ? product.active : Boolean(input.active),
    size: input.size == null ? product.size : String(input.size).trim(),
    color: input.color == null ? product.color : String(input.color).trim(),
  }
  const next = { ...database, products: database.products.map((entry) => entry.id === product.id ? updated : entry), auditHistory: addAudit(database, 'product-update', product.id, `Product ${updated.name} updated`) }
  return { database: next, record: updated }
}

export function updateAccountDetails(database, input) {
  const key = input.accountType === 'supplier' ? 'suppliers' : 'customers'
  const account = database[key].find((entry) => entry.id === input.accountId)
  if (!account) throw new Error(`The ${input.accountType || 'customer'} account could not be found.`)
  const supplierCode = input.accountType === 'supplier' && input.supplierCode != null ? String(input.supplierCode).trim().toUpperCase() : account.supplierCode
  if (input.accountType === 'supplier' && supplierCode && database.suppliers.some((entry) => entry.id !== account.id && String(entry.supplierCode || '').trim().toUpperCase() === supplierCode)) throw new Error('A supplier with this code already exists.')
  const updated = {
    ...account,
    name: input.name == null ? account.name : String(input.name).trim(),
    ...(input.accountType === 'supplier' ? { supplierCode } : {}),
    phone: input.phone == null ? account.phone : String(input.phone).trim(),
    address: input.address == null ? account.address : String(input.address).trim(),
    city: input.city == null ? account.city : String(input.city).trim(),
    notes: input.notes == null ? account.notes : String(input.notes).trim(),
    active: input.active == null ? account.active : Boolean(input.active),
  }
  const next = { ...database, [key]: database[key].map((entry) => entry.id === account.id ? updated : entry), auditHistory: addAudit(database, `${input.accountType || 'customer'}-update`, account.id, `${updated.name} details updated`) }
  return { database: next, record: updated }
}

export function updateSaleReceiptDetails(database, input) {
  const sale = database.sales.find((entry) => entry.id === input.saleId)
  if (!sale) throw new Error('Sale could not be found.')
  const paymentDue = input.paymentDue == null ? sale.paymentDue || '' : String(input.paymentDue).trim()
  if (paymentDue && !/^\d{4}-\d{2}-\d{2}$/.test(paymentDue)) throw new Error('Enter a valid payment due date.')
  const updated = {
    ...sale,
    padInvoiceNumber: input.padInvoiceNumber == null ? sale.padInvoiceNumber : String(input.padInvoiceNumber).trim(),
    customerPhone: input.customerPhone == null ? sale.customerPhone : String(input.customerPhone).trim(),
    customerAddress: input.customerAddress == null ? sale.customerAddress : String(input.customerAddress).trim(),
    paymentDue,
  }
  return { database: { ...database, sales: database.sales.map((entry) => entry.id === sale.id ? updated : entry), auditHistory: addAudit(database, 'sale-receipt-update', sale.id, `Receipt details updated for ${sale.number}`) }, record: updated }
}

export function updateSaleBill(database, input) {
  const sale = database.sales.find((entry) => entry.id === input.saleId)
  if (!sale) throw new Error('Sale could not be found.')
  if ((sale.items || []).some((item) => item.isReturn || item.originalSaleId) || database.returns.some((entry) => entry.saleId === sale.id || entry.adjustmentSaleId === sale.id)) {
    throw new Error('A bill linked to returns cannot be edited. Process a separate correction instead.')
  }
  if (!sale.payments || !['paid', 'credit'].includes(sale.status)) throw new Error('This bill has incomplete payment history and cannot be edited safely.')
  const originalItems = sale.items || []
  if (!originalItems.length) throw new Error('This bill has no saved items to reconcile safely.')
  if (!Array.isArray(input.items) || input.items.length === 0) throw new Error('A bill must keep at least one item. Add an item before saving.')
  const movements = database.stockMovements.filter((entry) => entry.type === 'sale' && entry.referenceId === sale.id)
  if (movements.length !== originalItems.length) throw new Error('This bill has incomplete stock movement history and cannot be edited safely.')
  if (movements.some((movement, index) => movement.productId !== originalItems[index].productId)) throw new Error('This bill has mismatched stock movement history and cannot be edited safely.')
  const itemByLine = new Map(originalItems.map((item) => [item.lineId, item]))
  if (itemByLine.size !== originalItems.length) throw new Error('This bill has duplicate item line history and cannot be edited safely.')
  const retainedLineIds = new Set()
  const items = input.items.map((submitted) => {
    const lineId = String(submitted.lineId || '').trim()
    const quantity = positiveQuantity(submitted.quantity)
    const price = amountOf(submitted.price)
    if (lineId) {
      const original = itemByLine.get(lineId)
      if (!original || retainedLineIds.has(lineId)) throw new Error('Bill items must use unique saved item lines.')
      retainedLineIds.add(lineId)
      return { ...original, quantity, price, unitPrice: price, lineTotal: quantity * price }
    }
    const product = getProduct(database.products, { productId: submitted.productId })
    return {
      lineId: makeId('line'),
      productId: product.id,
      code: product.code ?? '',
      name: product.name,
      quantity,
      price,
      unitPrice: price,
      unitCostAtSale: Number(product.averageCost || 0),
      lineTotal: quantity * price,
    }
  })
  const subtotal = items.reduce((sum, item) => sum + item.lineTotal, 0)
  const discount = amountOf(input.discount ?? sale.discount ?? 0)
  if (discount > subtotal) throw new Error('Discount cannot exceed the subtotal.')
  const total = subtotal - discount
  const paymentInput = input.payments ?? sale.payments
  const cash = amountOf(paymentInput?.cash ?? 0)
  const bank = amountOf(paymentInput?.bankTransfer ?? paymentInput?.bank ?? 0)
  const cheque = amountOf(paymentInput?.cheque ?? 0)
  if (cash + bank + cheque > total + 0.005) throw new Error('The edited total cannot be less than payments already recorded.')
  const linkedCheques = database.cheques.filter((entry) => entry.sourceType === 'sale' && entry.referenceId === sale.id)
  const activeCheques = linkedCheques.filter((entry) => entry.status !== 'Cancelled')
  if (input.payments && activeCheques.length > 1) throw new Error('This bill has multiple linked cheques; update those through the cheque register.')
  const activeCheque = activeCheques[0]
  const chequeInput = input.cheque || paymentInput?.chequeDetails || {}
  const chequeInfoChanged = activeCheque && cheque > 0 && (
    Number(activeCheque.amount || 0) !== cheque
    || String(activeCheque.number || '') !== String(chequeInput.chequeNumber ?? chequeInput.number ?? activeCheque.number ?? '')
    || String(activeCheque.bank || '') !== String(chequeInput.bankName ?? chequeInput.bank ?? activeCheque.bank ?? '')
    || String(activeCheque.issued || '') !== String(chequeInput.chequeDate ?? chequeInput.issued ?? activeCheque.issued ?? '')
    || String(activeCheque.expectedClearanceDate || '') !== String(chequeInput.dueDate ?? chequeInput.expectedClearanceDate ?? activeCheque.expectedClearanceDate ?? '')
  )
  const chequeIsSettled = activeCheque && !['Pending', 'Deposited / Presented', 'Under Clearing', 'Rescheduled'].includes(activeCheque.status)
  if (input.payments && chequeIsSettled && (chequeInfoChanged || cash !== amountOf(sale.payments?.cash) || bank !== amountOf(sale.payments?.bank ?? sale.payments?.bankTransfer) || cheque !== amountOf(sale.payments?.cheque))) {
    throw new Error('This bill has a cleared or resolved cheque; its payment split cannot be changed safely.')
  }
  if (chequeInfoChanged && activeCheque && activeCheque.status !== 'Pending') throw new Error('Only a pending cheque can be changed while editing a bill.')
  const due = Math.max(0, total - cash - bank)
  if (due > 0 && !sale.customerId) throw new Error('A bill with unpaid balance needs a customer.')
  const oldByProduct = new Map()
  const newByProduct = new Map()
  for (const item of originalItems) oldByProduct.set(item.productId, (oldByProduct.get(item.productId) || 0) + Number(item.quantity || 0))
  for (const item of items) newByProduct.set(item.productId, (newByProduct.get(item.productId) || 0) + item.quantity)
  for (const [productId, quantity] of newByProduct) {
    const product = database.products.find((entry) => entry.id === productId)
    if (!product) throw new Error('A bill product could not be found.')
    if (Number(product.stockQuantity || 0) + (oldByProduct.get(productId) || 0) - Number(product.reservedQuantity || 0) < quantity) throw new Error(`Not enough available stock for ${product.name}.`)
  }
  const products = database.products.map((product) => ({ ...product, stockQuantity: Number(product.stockQuantity || 0) + (oldByProduct.get(product.id) || 0) - (newByProduct.get(product.id) || 0) }))
  const updated = {
    ...sale,
    items,
    subtotal,
    discount,
    total,
    due,
    paid: cash + bank,
    payments: {
      ...sale.payments,
      cash,
      bank,
      cheque,
      chequeDetails: cheque > 0 ? {
        ...(sale.payments?.chequeDetails || {}),
        chequeNumber: String(chequeInput.chequeNumber ?? chequeInput.number ?? activeCheque?.number ?? '').trim(),
        bankName: String(chequeInput.bankName ?? chequeInput.bank ?? activeCheque?.bank ?? '').trim(),
        chequeDate: String(chequeInput.chequeDate ?? chequeInput.issued ?? activeCheque?.issued ?? sale.date ?? '').slice(0, 10),
        dueDate: String(chequeInput.dueDate ?? chequeInput.expectedClearanceDate ?? activeCheque?.expectedClearanceDate ?? '').slice(0, 10),
        amount: cheque,
        status: activeCheque?.status || 'Pending',
      } : null,
    },
    cheque: cheque > 0 ? {
      ...(sale.cheque || {}),
      ...chequeInput,
      chequeNumber: String(chequeInput.chequeNumber ?? chequeInput.number ?? activeCheque?.number ?? '').trim(),
      bankName: String(chequeInput.bankName ?? chequeInput.bank ?? activeCheque?.bank ?? '').trim(),
      chequeDate: String(chequeInput.chequeDate ?? chequeInput.issued ?? activeCheque?.issued ?? sale.date ?? '').slice(0, 10),
      dueDate: String(chequeInput.dueDate ?? chequeInput.expectedClearanceDate ?? activeCheque?.expectedClearanceDate ?? '').slice(0, 10),
      amount: cheque,
      status: activeCheque?.status || 'Pending',
    } : null,
    bankDetails: bank > 0 ? {
      bankName: String(input.bankDetails?.bankName ?? sale.bankDetails?.bankName ?? '').trim(),
      accountNumber: String(input.bankDetails?.accountNumber ?? sale.bankDetails?.accountNumber ?? '').trim(),
      amount: bank,
    } : null,
    status: due > 0 ? 'credit' : 'paid',
    padInvoiceNumber: input.padInvoiceNumber == null ? sale.padInvoiceNumber || '' : String(input.padInvoiceNumber).trim(),
    customerPhone: input.customerPhone == null ? sale.customerPhone || '' : String(input.customerPhone).trim(),
    customerAddress: input.customerAddress == null ? sale.customerAddress || '' : String(input.customerAddress).trim(),
  }
  const movementByLine = new Map(originalItems.map((item, index) => [item.lineId, movements[index]]))
  const retainedMovements = database.stockMovements.filter((movement) => movement.type !== 'sale' || movement.referenceId !== sale.id)
  const updatedMovements = items.map((item) => {
    const originalMovement = movementByLine.get(item.lineId)
    if (originalMovement) return { ...originalMovement, productId: item.productId, quantity: -item.quantity }
    return record('move', { productId: item.productId, type: 'sale', quantity: -item.quantity, referenceId: sale.id, date: sale.date, note: sale.number || 'Sale' })
  })
  const customers = sale.customerId ? updateBalance(database.customers, sale.customerId, due - Number(sale.due || 0)) : database.customers
  let payments = database.payments
  if (input.payments) {
    for (const [method, amount] of [['cash', cash], ['bank', bank]]) {
      const linked = payments.filter((entry) => entry.type === 'customer-payment' && entry.referenceId === sale.id && entry.method === method)
      const keepId = linked[0]?.id
      payments = payments.map((entry) => entry.type === 'customer-payment' && entry.referenceId === sale.id && entry.method === method
        ? { ...entry, amount: entry.id === keepId ? amount : 0, ...(method === 'bank' ? { bankDetails: updated.bankDetails } : {}) }
        : entry)
      if (!linked.length && amount > 0) payments = addPayment({ ...database, payments }, { type: 'customer-payment', method, amount, ...(method === 'bank' ? { bankDetails: updated.bankDetails } : {}), customerId: sale.customerId, referenceId: sale.id, date: sale.date })
    }
  }
  let cheques = database.cheques
  if (input.payments && activeCheque && cheque > 0) {
    cheques = cheques.map((entry) => entry.id === activeCheque.id ? {
      ...entry,
      amount: cheque,
      number: String(chequeInput.chequeNumber ?? chequeInput.number ?? entry.number ?? '').trim(),
      bank: String(chequeInput.bankName ?? chequeInput.bank ?? entry.bank ?? '').trim(),
      issued: String(chequeInput.chequeDate ?? chequeInput.issued ?? entry.issued ?? sale.date).slice(0, 10),
      expectedClearanceDate: String(chequeInput.dueDate ?? chequeInput.expectedClearanceDate ?? entry.expectedClearanceDate ?? '').slice(0, 10),
    } : entry)
  } else if (input.payments && activeCheque && cheque === 0) {
    const timestamp = now()
    cheques = cheques.map((entry) => entry.id === activeCheque.id ? { ...entry, amount: 0, status: 'Cancelled', cancelledAt: timestamp, statusHistory: [...(entry.statusHistory || []), { status: 'Cancelled', date: timestamp, remarks: 'Cheque removed while editing sale bill' }] } : entry)
  } else if (input.payments && cheque > 0) {
    cheques = [record('cheque', {
      direction: 'received', partyType: 'customer', partyId: sale.customerId, party: sale.customer, amount: cheque,
      issued: String(chequeInput.chequeDate ?? chequeInput.issued ?? sale.date).slice(0, 10),
      bank: String(chequeInput.bankName ?? chequeInput.bank ?? '').trim(), number: String(chequeInput.chequeNumber ?? chequeInput.number ?? '').trim(),
      expectedClearanceDate: String(chequeInput.dueDate ?? chequeInput.expectedClearanceDate ?? '').slice(0, 10), sourceType: 'sale', referenceId: sale.id, status: 'Pending',
    }), ...cheques]
  }
  const next = { ...database, sales: database.sales.map((entry) => entry.id === sale.id ? updated : entry), products, customers, payments, cheques, stockMovements: [...retainedMovements, ...updatedMovements], auditHistory: addAudit(database, 'sale-bill-update', sale.id, `Bill ${sale.number} items, quantities, rates or payment split updated`) }
  return { database: next, record: updated }
}

export function nextDocumentNumber(database, key, prefix) {
  const value = Number(database.counters?.[key] || 0) + 1
  return `${prefix}-${String(value).padStart(4, '0')}`
}

export function filterByDateRange(rows, from, to) {
  return rows.filter((entry) => {
    const date = String(entry.date || '').slice(0, 10)
    if (from && date < from) return false
    if (to && date > to) return false
    return true
  })
}

export function searchSales(database, query = '') {
  const needle = String(query).trim().toLowerCase()
  if (!needle) return database.sales
  return database.sales.filter((sale) => {
    const haystack = [sale.number, sale.padInvoiceNumber, sale.customer, sale.customerPhone, sale.id, ...(sale.items || []).map((item) => item.code), ...(sale.items || []).map((item) => item.name)].join(' ').toLowerCase()
    return haystack.includes(needle)
  })
}

export function buildThermalInvoice(database, saleId) {
  const sale = database.sales.find((entry) => entry.id === saleId)
  if (!sale) throw new Error('Sale could not be found.')
  const settings = database.settings || {}
  const customer = database.customers.find((entry) => entry.id === sale.customerId)
  return {
    shopName: settings.shopName || 'KataSys',
    receiptFooter: settings.receiptFooter || 'Thank you',
    sale,
    cheques: database.cheques.filter((entry) => entry.referenceId === sale.id),
    customer: { ...(customer || { name: sale.customer }), phone: sale.customerPhone || customer?.phone || '', address: sale.customerAddress || customer?.address || '' },
    reprint: true,
  }
}

export function periodBounds(period, date = localDateString()) {
  const current = new Date(`${date}T00:00:00`)
  if (period === 'weekly') {
    const start = new Date(current)
    start.setDate(current.getDate() - 6)
    return { from: localDateString(start), to: date }
  }
  if (period === 'monthly') {
    const start = new Date(current.getFullYear(), current.getMonth(), 1)
    return { from: localDateString(start), to: date }
  }
  return { from: date, to: date }
}

export function calculateReports(database, { from, to, period } = {}) {
  const bounds = from || to ? { from: from || '', to: to || '' } : periodBounds(period || 'daily')
  const sales = filterByDateRange(database.sales, bounds.from, bounds.to)
  const purchases = filterByDateRange(database.purchases, bounds.from, bounds.to)
  const expenses = filterByDateRange(database.expenses, bounds.from, bounds.to)
  const payments = filterByDateRange(database.payments, bounds.from, bounds.to)
  const subset = { ...financialPeriodDatabase(database, bounds.from, bounds.to), purchases, expenses, payments }
  return {
    period: period || 'custom',
    from: bounds.from,
    to: bounds.to,
    totals: calculateBusinessTotals(subset),
    salesCount: sales.length,
    purchaseCount: purchases.length,
    cashCollected: payments.filter((entry) => entry.method === 'cash' && entry.type === 'customer-payment').reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
    bankCollected: payments.filter((entry) => entry.method === 'bank' && entry.type === 'customer-payment').reduce((sum, entry) => sum + Number(entry.amount || 0), 0),
  }
}

export function stockAudit(database) {
  return database.products.map((product) => ({
    id: product.id,
    name: product.name,
    code: product.code,
    batchNumber: product.batchNumber || '',
    purchaseId: product.purchaseId || '',
    rackLocation: product.rackLocation || '',
    available: Number(product.stockQuantity || 0) - Number(product.reservedQuantity || 0),
    reserved: Number(product.reservedQuantity || 0),
    defective: Number(product.defectiveQuantity || 0),
    stockQuantity: Number(product.stockQuantity || 0),
    averageCost: Number(product.averageCost || 0),
    salePrice: Number(product.salePrice || 0),
    stockValue: Number(product.stockQuantity || 0) * Number(product.averageCost || 0),
  }))
}

export function accountAudit(database) {
  return {
    customers: database.customers.map((account) => ({ ...calculateAccountLedger(database, 'customer', account.id), id: account.id, name: account.name, storedBalance: Number(account.balance || 0) })),
    suppliers: database.suppliers.map((account) => ({ ...calculateAccountLedger(database, 'supplier', account.id), id: account.id, name: account.name, storedBalance: Number(account.balance || 0) })),
  }
}

export function supplierStatement(database, supplierId) {
  const supplier = database.suppliers.find((entry) => entry.id === supplierId)
  if (!supplier) throw new Error('Supplier could not be found.')
  const ledger = calculateAccountLedger(database, 'supplier', supplierId)
  return {
    supplier,
    ledger,
    stock: database.products.filter((product) => product.supplierId === supplierId),
    purchases: database.purchases.filter((entry) => entry.supplierId === supplierId),
    payments: database.payments.filter((entry) => entry.supplierId === supplierId),
    cheques: database.cheques.filter((entry) => entry.partyId === supplierId),
    pendingCheques: database.cheques.filter((entry) => entry.partyId === supplierId && entry.status === 'Pending'),
    clearedCheques: database.cheques.filter((entry) => entry.partyId === supplierId && entry.status === 'Cleared'),
    returns: database.supplierReturns.filter((entry) => entry.supplierId === supplierId),
  }
}

export function customerStatement(database, customerId) {
  const customer = database.customers.find((entry) => entry.id === customerId)
  if (!customer) throw new Error('Customer could not be found.')
  return {
    customer,
    ledger: calculateAccountLedger(database, 'customer', customerId),
    sales: database.sales.filter((entry) => entry.customerId === customerId),
    payments: database.payments.filter((entry) => entry.customerId === customerId),
    returns: database.returns.filter((entry) => entry.customerId === customerId),
    cheques: database.cheques.filter((entry) => entry.partyId === customerId),
    installments: (database.installments || []).filter((entry) => entry.customerId === customerId),
  }
}

export function bankSummary(database, date) {
  const sameDate = (entry) => !date || entry.date === date
  const bankIn = database.payments.filter((entry) => sameDate(entry) && entry.type === 'customer-payment' && (entry.method === 'bank' || entry.method === 'cheque-cleared')).reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const bankOut = database.payments.filter((entry) => sameDate(entry) && entry.type === 'supplier-payment' && (entry.method === 'bank' || entry.method === 'cheque-cleared')).reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const transfers = (database.financeEntries || []).filter((entry) => sameDate(entry) && entry.type === 'transfer').reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  const capital = (database.financeEntries || []).filter((entry) => sameDate(entry) && entry.type === 'capital').reduce((sum, entry) => sum + Number(entry.amount || 0), 0)
  return { date: date || 'all', bankIn, bankOut, transfers, capital, netBank: bankIn + capital - bankOut - transfers }
}
