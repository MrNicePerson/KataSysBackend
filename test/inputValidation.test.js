import test from 'node:test'
import assert from 'node:assert/strict'
import { validDate, returnRefundAmount } from '../src/domain/inputValidation.js'
test('calendar validation rejects rollover dates and allows leap day',()=>{
 assert.equal(validDate('2026-02-30'),false);assert.equal(validDate('2026-04-31'),false);assert.equal(validDate('2024-02-29'),true);assert.equal(validDate('2026-02-29'),false)
})
test('partial return cent rounding never exceeds original discounted line value',()=>{
 const item={quantity:3,unitPrice:1};const sale={subtotal:3,discount:1,items:[item]}
 const amounts=[0,1,2].map(already=>returnRefundAmount(sale,item,1,already))
 assert.deepEqual(amounts,[0.67,0.66,0.67]);assert.equal(amounts.reduce((sum,n)=>sum+Math.round(n*100),0),200)
})
test('discounted mixed item refunds sum to original bill net value',()=>{
 const items=[{quantity:2,unitPrice:10},{quantity:1,unitPrice:30}];const sale={subtotal:50,discount:5,items}
 assert.equal(items.reduce((sum,item)=>sum+returnRefundAmount(sale,item,item.quantity),0),45)
})
