import { describe,it,expect } from 'vitest';
import { z } from 'zod';
import { jobTaskPayload } from './job-task-payload.js';

describe('persisted job envelope',()=>{
 it('separates admission and monitoring metadata without mutating stored payload or weakening task validation',()=>{
  const payload={binding:'fixture',generation:'1',promptPin:{version:'prompt-catalog-v1'},errorHistory:[{message:'Previous attempt'}],dashboardDismissedAt:'2026-09-12T00:00:00Z'};
  const before=structuredClone(payload),task=jobTaskPayload(payload);
  expect(task).toEqual({binding:'fixture',generation:'1'});expect(payload).toEqual(before);
  const schema=z.object({binding:z.string(),generation:z.string()}).strict();expect(schema.parse(task)).toEqual(task);
  expect(()=>schema.parse(jobTaskPayload({...payload,unknownTaskAuthority:true}))).toThrow();
 });
 it('keeps legacy task-only payloads equivalent',()=>{expect(jobTaskPayload({action:'write',content:'Literal %promptPin%'})).toEqual({action:'write',content:'Literal %promptPin%'});});
});
