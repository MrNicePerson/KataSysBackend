import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyDatabase, calculateBusinessTotals, financialPeriodDatabase } from '../src/domain/businessLogic.js'
for (const refundType of ['cash', 'khata', 'sale-adjustment']) test('return belongs to original day: '+refundType, () => {
 const db=createEmptyDatabase()
 db.sales=[{id:'old',date:'2026-09-30',total:200,items:[{lineId:'l',quantity:2,unitCostAtSale:50}]}]
 db.returns=[{saleId:'old',lineId:'l',date:'2026-10-23',quantity:1,amount:100,condition:'sellable',refundType}]
 if(refundType==='sale-adjustment') db.sales.push({id:'new',date:'2026-10-23',total:100,returnTotal:100,items:[{quantity:1,unitCostAtSale:120},{isReturn:true,quantity:1,unitCostAtSale:50}]})
 const old=calculateBusinessTotals(financialPeriodDatabase(db,'2026-09-30','2026-09-30'))
 assert.equal(old.netSales,100);assert.equal(old.estimatedGrossProfit,50)
 const today=calculateBusinessTotals(financialPeriodDatabase(db,'2026-10-23','2026-10-23'))
 assert.equal(today.netSales,refundType==='sale-adjustment'?200:0)
 assert.equal(today.estimatedGrossProfit,refundType==='sale-adjustment'?80:0)
 assert.equal(db.sales[0].total,200);assert.equal(db.returns[0].date,'2026-10-23')
})
