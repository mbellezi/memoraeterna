import { describe, expect, it } from "vitest";
import { WikiPageContentSchema, WikiPageListSchema, WikiPageSchema, WikiQuerySchema, WikiSaveInputSchema } from "./wiki.js";
const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
describe("wiki boundary contracts",()=>{
  it("loads refined page and derived list contracts without runtime composition errors",()=>{
    expect(WikiPageListSchema.parse([])).toEqual([]);
    expect(WikiPageSchema.safeParse({}).success).toBe(false);
  });
  it("rejects duplicate stable section identities and arbitrary mutation fields",()=>{
    expect(WikiPageContentSchema.safeParse({title:"Page",kind:"topic",sections:[{id,title:"First",markdown:"One"},{id,title:"Second",markdown:"Two"}]}).success).toBe(false);
    expect(WikiSaveInputSchema.safeParse({expectedRevisionId:null,content:{title:"Page",kind:"topic"},sql:"delete"}).success).toBe(false);
  });
  it("defaults to bounded current text consultation without AI capabilities",()=>{
    expect(WikiQuerySchema.parse({})).toMatchObject({limit:30,currentOnly:true,reviewedOnly:false,sourceIds:[],includeDescendants:true});
    expect(WikiQuerySchema.safeParse({limit:1001}).success).toBe(false);
    expect(WikiQuerySchema.safeParse({sourceIds:["not-an-id"]}).success).toBe(false);
  });
  it("protects manual sections independently from draft review",()=>{
    expect(WikiPageContentSchema.parse({title:"Page",kind:"topic",sections:[{id,title:"Idea",markdown:"My interpretation"}]})).toMatchObject({review:"draft",sections:[{protected:true,provenance:"personal"}]});
  });
});
