export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(value + 'T00:00:00Z')
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value
}
export function requireDate(value) {
  if (!validDate(value)) throw new Error('Enter a valid calendar date (YYYY-MM-DD).')
  return value
}
export function returnRefundAmount(sale, item, quantity, alreadyReturned = 0) {
  const price = Number(item.unitPrice ?? item.price ?? 0)
  const subtotal = Number(sale.subtotal ?? (sale.items || []).filter(line => !line.isReturn).reduce((sum, line) => sum + Number(line.quantity || 0) * Number(line.unitPrice ?? line.price ?? 0), 0))
  const discount = Number(sale.discount || 0)
  const unitNet = price * (subtotal > 0 ? Math.max(0, 1 - discount / subtotal) : 1)
  const cents = value => Math.round((value + Number.EPSILON) * 100)
  return (cents((alreadyReturned + quantity) * unitNet) - cents(alreadyReturned * unitNet)) / 100
}
export function validateBackupNumbers(database) {
  for (const product of database.products) {
    for (const key of ['stockQuantity', 'reservedQuantity', 'defectiveQuantity']) {
      if (product[key] != null && (!Number.isSafeInteger(Number(product[key])) || Number(product[key]) < 0)) throw new Error('Backup contains invalid stock quantities.')
    }
    if (Number(product.reservedQuantity || 0) > Number(product.stockQuantity || 0)) throw new Error('Backup reserves more stock than exists.')
    for (const key of ['averageCost', 'salePrice']) if (product[key] != null && (!Number.isFinite(Number(product[key])) || Number(product[key]) < 0)) throw new Error('Backup contains invalid product amounts.')
  }
  for (const account of [...database.customers, ...database.suppliers]) for (const key of ['balance', 'openingBalance']) {
    if (account[key] != null && !Number.isFinite(Number(account[key]))) throw new Error('Backup contains invalid account balances.')
  }
}
