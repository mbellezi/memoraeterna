import { describe, expect, it } from 'vitest';
import { automaticBudgetExceeded } from './automaticMaintenanceRepository.js';

describe('recorded automatic generation budgets',()=>{
  const limit={calls:2,tokens:1000,spend:null};
  it('allows a new generation at equality, including a zero limit',()=>{
    expect(automaticBudgetExceeded({calls:2,tokens:1000,spend:null},limit)).toBe(false);
    expect(automaticBudgetExceeded({calls:0,tokens:0,spend:null},{calls:0,tokens:0,spend:null})).toBe(false);
  });
  it('blocks the next generation after either recorded counter crosses its limit',()=>{
    expect(automaticBudgetExceeded({calls:3,tokens:1,spend:null},limit)).toBe(true);
    expect(automaticBudgetExceeded({calls:1,tokens:1001,spend:null},limit)).toBe(true);
  });
  it('uses known spend without fabricating an estimate for missing provider data',()=>{
    expect(automaticBudgetExceeded({calls:1,tokens:1,spend:null},{...limit,spend:1})).toBe(false);
    expect(automaticBudgetExceeded({calls:1,tokens:1,spend:1},{...limit,spend:1})).toBe(false);
    expect(automaticBudgetExceeded({calls:1,tokens:1,spend:1.01},{...limit,spend:1})).toBe(true);
  });
});
