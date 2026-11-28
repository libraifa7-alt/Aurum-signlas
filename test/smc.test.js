'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {analyzeSmartMoney}=require('../api/smc');

function series(values){
  return values.map((v,i)=>({time:1700000000+i*300,open:v,high:v+1,low:v-1,close:v+0.2}));
}
test('returns explicit insufficient-data status',()=>{
  assert.equal(analyzeSmartMoney(series([10,11,12]),'M15').status,'INSUFFICIENT_DATA');
});
test('reports a structured analysis without look-ahead output fields',()=>{
  const data=series([10,11,10,12,11,13,12,14,13,15,14,16,15,17,16,18,17,19,18,20,19,21,20,22,21,23,22,24,23,25,24,26]);
  const out=analyzeSmartMoney(data,'M15');
  assert.equal(out.status,'OK');
  assert.equal(out.timeframe,'M15');
  assert.ok(Array.isArray(out.fvgs));
  assert.ok(Array.isArray(out.supportResistance));
  assert.ok(['PREMIUM','DISCOUNT','EQUILIBRIUM'].includes(out.premiumDiscount.zone));
});
