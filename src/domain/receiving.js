// Old deliveries may have a batch per item rather than one batch per bill.
// Keep their original references available without rewriting historical stock.
export function receivingLabel(purchase) {
  if (!purchase) return ''
  if (purchase.batchNumber) return purchase.batchNumber
  const items = purchase.items || []
  const batch = items[0]?.batchNumber
  if (batch && items.every((item) => item.batchNumber === batch)) return batch
  return purchase.reference || purchase.id || ''
}

export function nextReceivingBatch(database, supplier, date) {
  const code = String(supplier?.supplierCode || '').trim().toUpperCase()
  if (!code) throw new Error('Add a Supplier Code to the selected supplier before receiving stock.')
  const value = new Date(`${date}T00:00:00Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || !Number.isFinite(value.getTime()) || value.toISOString().slice(0, 10) !== date) throw new Error('Receive Stock date is invalid.')
  const purchases = database.purchases || []
  const own = purchases.filter((purchase) => purchase.supplierId === supplier.id)
  const previous = own.reduce((max, purchase) => {
    const saved = Number(purchase.supplierBillNumber || 0)
    const match = receivingLabel(purchase).match(/-\d{8}-(\d+)$/)
    return Math.max(max, saved, match ? Number(match[1]) : 0)
  }, Math.max(own.length, Number(database.counters?.supplierReceivings?.[supplier.id] || 0)))
  const [year, month, day] = date.split('-')
  const used = new Set(purchases.flatMap((purchase) => [purchase.batchNumber, ...(purchase.items || []).map((item) => item.batchNumber)]).filter(Boolean).map((batch) => batch.toUpperCase()))
  let supplierBillNumber = previous + 1
  let batchNumber = `${code}-${day}${month}${year}-${String(supplierBillNumber).padStart(3, '0')}`
  while (used.has(batchNumber)) {
    supplierBillNumber += 1
    batchNumber = `${code}-${day}${month}${year}-${String(supplierBillNumber).padStart(3, '0')}`
  }
  return { batchNumber, supplierBillNumber }
}
