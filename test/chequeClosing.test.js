import test from 'node:test'
import assert from 'node:assert/strict'
import { createEmptyDatabase, saveDailyRecord } from '../src/domain/businessLogic.js'
const date='2026-10-23'
function fixture(status='Pending') {
 const db=createEmptyDatabase(); db.dailyClosings=[{id:'opening',type:'opening',date,amount:0,branchId:'default'}]
 db.cheques=[{id:'c',number:'CH-100',direction:'received',dueDate:date,status}];return db
}
for(const status of ['Pending','Deposited / Presented','Under Clearing','Rescheduled']) test('closing blocked for due customer cheque: '+status,()=>{
 const db=fixture(status);assert.throws(()=>saveDailyRecord(db,{date,type:'closing',amount:0}),/CH-100/);assert.equal(db.dailyClosings.length,1)
})
for(const status of ['Cleared','Returned','Cancelled','Bounced','Bounced / Dishonoured','Replaced']) test('closing allowed after cheque resolved: '+status,()=>assert.doesNotThrow(()=>saveDailyRecord(fixture(status),{date,type:'closing',amount:0})))
test('future, outgoing cheques and daily opening are not blocked',()=>{
 const db=fixture();assert.doesNotThrow(()=>saveDailyRecord(db,{date,type:'opening',amount:0}))
 db.cheques[0].expectedClearanceDate='2026-10-24';assert.doesNotThrow(()=>saveDailyRecord(db,{date,type:'closing',amount:0}))
 delete db.cheques[0].expectedClearanceDate;db.cheques[0].direction='given';assert.doesNotThrow(()=>saveDailyRecord(db,{date,type:'closing',amount:0}))
})
