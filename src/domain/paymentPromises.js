export function validatePaymentPromises(rows = [], { customerId, customers, due }) {
  if (!Array.isArray(rows)) throw new Error('Payment promises must be a list.')
  const promises = rows.flatMap((row, index) => {
    const dueDate = String(row?.dueDate ?? '').trim()
    const rawAmount = String(row?.amount ?? '').trim()
    if (!dueDate && !rawAmount) return []
    const amount = Number(rawAmount)
    const date = new Date(`${dueDate}T00:00:00Z`)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== dueDate) throw new Error(`Payment promise ${index + 1}: enter a valid due date.`)
    if (!rawAmount || !Number.isFinite(amount) || amount <= 0) throw new Error(`Payment promise ${index + 1}: enter a positive amount.`)
    return [{ dueDate, amount }]
  })
  if (promises.length && !customers.some((customer) => customer.id === customerId && customer.active !== false)) throw new Error('Choose a saved customer for payment promises.')
  if (promises.reduce((sum, row) => sum + row.amount, 0) > due + 0.005) throw new Error('Payment promises cannot exceed the unpaid amount due.')
  return promises
}

// Allocate recovered customer debt oldest first; opening debt precedes new bills.
// Scheduling never changes these balances or creates a payment.
export function paymentPromiseStates(database) {
  const result = []
  for (const customer of database.customers || []) {
    const sales = (database.sales || []).filter((sale) => sale.customerId === customer.id).sort((a, b) => `${a.date}${a.createdAt || a.id}`.localeCompare(`${b.date}${b.createdAt || b.id}`))
    const opening = Math.max(0, Number(customer.openingBalance || 0))
    const debt = sales.reduce((sum, sale) => sum + Math.max(0, Number(sale.due || 0)), opening)
    let recovered = Math.max(0, debt - Math.max(0, Number(customer.balance || 0)))
    recovered = Math.max(0, recovered - opening)
    for (const sale of sales) {
      const applied = Math.min(recovered, Math.max(0, Number(sale.due || 0)))
      recovered -= applied
      let remainingApplied = applied
      for (const promise of [...(sale.paymentPromises || [])].sort((a, b) => a.dueDate.localeCompare(b.dueDate))) {
        const paid = Math.min(remainingApplied, promise.amount)
        remainingApplied -= paid
        result.push({ ...promise, saleId: sale.id, saleNumber: sale.number, customerId: customer.id, customer: customer.name, remaining: promise.amount - paid, status: promise.status === 'cancelled' ? 'cancelled' : paid >= promise.amount ? 'fulfilled' : 'scheduled' })
      }
    }
  }
  return result
}
