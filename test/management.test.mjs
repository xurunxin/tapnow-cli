import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { changePlan, saveChange, applyChange, canvasHash, groupPlan, layoutPlan, absolutePosition, commentPlan, comments } from '../src/canvas-management.mjs';
import { checkout, checkoutFile } from '../src/projects.mjs';
import { attachAssets, Library, roleSnapshot } from '../src/library.mjs';
import { apply, validate } from '../src/workflow.mjs';

const rawNode = (id, x=0, parent='') => ({ id, type:'text', position:{x,y:0}, parent_id:parent, measured:{width:300,height:200},data:{type:'pure',title:id,text:'brief',prompt:'brief'} });
const scene = () => ({ id:'canvas',org_id:'org',name:'Test',description:'',is_shared_with_org:false,nodes:[rawNode('one'),rawNode('two',450)],connections:[{id:'edge',source:'one',target:'two'}] });
const fake = canvas => ({ canvas,calls:[],identity:async()=>({userId:'user',orgId:'org'}),async request(method,path,body){
  this.calls.push({method,path,body}); if(method==='GET')return{canvas:structuredClone(this.canvas)};
  if(method==='PATCH'){Object.assign(this.canvas,body);return{};}
  if(path.endsWith('/nodes:batchActions')) { for(const action of body.actions){for(const n of action.creates||[])this.canvas.nodes.push(structuredClone(n));for(const n of action.updates||[])Object.assign(this.canvas.nodes.find(a=>a.id===n.id),structuredClone(n));} return{}; }
  if(path.endsWith('/connections:batchActions')) {for(const action of body.actions)this.canvas.connections.push(...action.creates||[]);return{};}
  throw new Error('Unexpected mutation');
} });
async function temp(t){const d=await fs.mkdtemp(join(tmpdir(),'tapnow-pm-'));t.after(()=>fs.rm(d,{recursive:true,force:true}));return d;}
test('group preserves global positions and rejects mixed parents',()=>{
  const c=scene(),before=c.nodes.map(n=>absolutePosition(c,n)),p=groupPlan(c,['one','two'],'Phase');
  c.nodes.push(...p.creates);p.updates.forEach(u=>Object.assign(c.nodes.find(n=>n.id===u.id),u));
  assert.deepEqual(c.nodes.slice(0,2).map(n=>absolutePosition(c,n)),before);
  assert.throws(()=>groupPlan(c,['one',p.creates[0].id],'Bad'),{code:'MIXED_PARENTS'});
});
test('flow layout orders dependencies, preserves unrelated nodes and avoids occupied space',()=>{
  const c=scene();c.nodes.push(rawNode('human',2000));const human=structuredClone(c.nodes[2]);const p=layoutPlan(c,['two','one']);
  assert.ok(p.updates.find(n=>n.id==='two').position.x>p.updates.find(n=>n.id==='one').position.x);
  assert.ok(p.updates.every(n=>n.position.x>2300));assert.deepEqual(c.nodes[2],human);
});
test('flow layout refuses cycles and grid can handle them',()=>{
  const c=scene();c.connections.push({id:'back',source:'two',target:'one'});
  assert.throws(()=>layoutPlan(c,['one','two']),{code:'GRAPH_CYCLE'});assert.equal(layoutPlan(c,['one','two'],'grid').updates.length,2);
});
test('management apply saves snapshot, verifies changes and never repeats a completed write',async t=>{
  const c=fake(scene()),file=join(await temp(t),'plan.json');await saveChange(file,groupPlan(c.canvas,['one','two'],'Phase'));
  assert.equal((await applyChange(c,file)).status,'verified');const count=c.calls.filter(x=>x.method==='POST').length;
  assert.equal((await applyChange(c,file)).alreadyApplied,true);assert.equal(c.calls.filter(x=>x.method==='POST').length,count);
  assert.equal(JSON.parse(await fs.readFile(file+'.before.json','utf8')).nodes.length,2);
});
test('human changes after planning prevent all mutations',async t=>{
  const c=fake(scene()),file=join(await temp(t),'plan.json');await saveChange(file,layoutPlan(c.canvas,['one','two']));c.canvas.nodes[0].data.text='human edit';
  await assert.rejects(applyChange(c,file),{code:'CANVAS_CONFLICT'});assert.equal(c.calls.filter(x=>x.method!=='GET').length,0);
});
test('ambiguous partial operation keeps receipt and forbids re-submission',async t=>{
  const c=fake(scene()),file=join(await temp(t),'plan.json');await saveChange(file,groupPlan(c.canvas,['one','two'],'Phase'));
  const original=c.request.bind(c);c.request=async(method,...args)=>{if(method==='POST')throw new Error('timeout');return original(method,...args);};
  await assert.rejects(applyChange(c,file),/timeout/);await assert.rejects(applyChange(c,file),{code:'OUTCOME_UNKNOWN'});
  assert.equal(JSON.parse(await fs.readFile(file+'.receipt.json','utf8')).status,'submitting');
});
test('wrong organization and edited plan receipt cannot mutate canvas',async t=>{
  const c=fake(scene()),file=join(await temp(t),'plan.json');await saveChange(file,groupPlan(c.canvas,['one'],'Phase'));c.identity=async()=>({orgId:'other'});
  await assert.rejects(applyChange(c,file),{code:'ORG_MISMATCH'});assert.equal(c.calls.length,0);
  c.identity=async()=>({orgId:'org'});await applyChange(c,file);
  const plan=JSON.parse(await fs.readFile(file,'utf8'));plan.purpose='Changed';await fs.writeFile(file,JSON.stringify(plan));
  const count=c.calls.filter(x=>x.method!=='GET').length;
  await assert.rejects(applyChange(c,file),{code:'PLAN_CHANGED'});assert.equal(c.calls.filter(x=>x.method!=='GET').length,count);
});
test('team sharing is a preview until applied and is read back',async t=>{
  const c=fake(scene()),file=join(await temp(t),'team.json');await saveChange(file,changePlan(c.canvas,'Share with current team',{project:{is_shared_with_org:true}}));assert.equal(c.canvas.is_shared_with_org,false);
  await applyChange(c,file);assert.equal(c.canvas.is_shared_with_org,true);
});
test('reply preserves prior human comments and edited feedback reappears unread',()=>{
  const c=scene(),first=commentPlan(c,{userId:'human',name:'Human'},{content:'Change lighting',atNode:'one'});c.nodes.push(...first.creates);
  const thread=comments(c)[0],m=thread.messages[0],cursor={[m.id]:m.revision};assert.equal(comments(c,cursor)[0].messages[0].acknowledged,true);
  const reply=commentPlan(c,{userId:'agent',name:'Agent'},{content:'Proposed warmer lighting',thread:thread.thread});assert.equal(reply.updates[0].data.comments[0].content,'Change lighting');
  c.nodes.find(n=>n.id===thread.thread).data.comments[0].content='Change to cool lighting';assert.equal(comments(c,cursor)[0].messages[0].acknowledged,false);
});
test('checkout pins completed results, keeps original remote IDs and excludes comments/groups',()=>{
  const c=scene();c.nodes.push({id:'image-original',type:'image',position:{x:600,y:0},data:{type:'generate',src:'https://files.tapnow.media/image.png',prompt:'old prompt',params:{model:'gpt-image-2'}}});c.nodes.push({id:'comment',type:'comment',position:{x:0,y:0},data:{comments:[]}});
  const r=checkout(c);assert.equal(r.plan.nodes.find(n=>n.type==='image').src,'https://files.tapnow.media/image.png');assert.equal(r.excluded[0].id,'comment');assert.ok(Object.values(r.state.nodes).includes('image-original'));assert.deepEqual(r.state.jobs,{});
});
test('checkout refuses possible in-flight jobs and does not overwrite local state',async t=>{
  const c=scene();c.nodes.push({id:'video',type:'video',data:{taskInfo:{taskId:'pending'}}});assert.throws(()=>checkout(c),{code:'PENDING_REMOTE_JOB'});
  const file=join(await temp(t),'plan.json');await fs.writeFile(file+'.tapnow-state.json','preserve');
  await assert.rejects(checkoutFile(fake(scene()),'canvas',file),{code:'EEXIST'});assert.equal(await fs.readFile(file+'.tapnow-state.json','utf8'),'preserve');await assert.rejects(fs.stat(file),{code:'ENOENT'});
});
test('workflow apply preserves human positions and appends new work beyond existing nodes',async()=>{
  const c=fake(scene()),r=checkout(c.canvas);c.canvas.nodes[0].position={x:1200,y:400};
  r.plan.nodes.push({id:'new-work',type:'text',prompt:'New requirements',params:{},times:1});const p=validate(r.plan);
  await apply(c,p,r.state,async()=>{});
  assert.deepEqual(c.canvas.nodes.find(n=>n.id==='one').position,{x:1200,y:400});assert.ok(c.canvas.nodes.find(n=>n.id===r.state.nodes['new-work']).position.x>1500);
});
test('adopting a completed image preserves model metadata and all candidate outputs',async()=>{
  const canvas=scene();const data={type:'generate',prompt:'Original',title:'Original',src:'https://files.tapnow.media/a.png',options:['https://files.tapnow.media/a.png','https://files.tapnow.media/b.png'],params:{model:'gpt-image-2',quality:'high'}};
  canvas.nodes.push({id:'image',type:'image',position:{x:1000,y:0},data:structuredClone(data)});
  const c=fake(canvas),r=checkout(canvas);await apply(c,r.plan,r.state,async()=>{});
  assert.deepEqual(c.canvas.nodes.find(n=>n.id==='image').data,data);
});
test('asset attachment reuses sources, preserves source provenance and rejects invalid target parameters',()=>{
  const p={version:1,project:{key:'role',name:'Role'},nodes:[{id:'film',type:'video',model:'MiniMax-H3',params:{}}],links:[]};
  const a={id:'asset',name:'Character',asset_type:'ASSET_TYPE_IMAGE',source_url:'https://files.tapnow.media/a.png'};
  const attached=attachAssets(p,'film',[a],{mode:'reference_to_video',role:{id:'role',revision:'r1',name:'Character',description:'Keep blue coat'}});
  assert.equal(attached.nodes.length,3);assert.equal(attached.links.length,2);assert.equal(attached.nodes[0].provenance.libraryReferences[0].assetId,'asset');
  assert.equal(attachAssets(attached,'film',[a],{mode:'reference_to_video',role:{id:'role',revision:'r1',name:'Character',description:'Keep blue coat'}}).nodes.length,3);
  assert.throws(()=>attachAssets(p,'film',[a],{mode:'text_to_video'}),{code:'INVALID_PARAMETER'});
});
test('roles use sourceAssetId for library assets and exact string revision for updates',async()=>{
  const calls=[],l=new Library({request:async(...args)=>{calls.push(args);return{};}});
  await l.createRole({name:'Character',members:[{sourceAssetId:'library-id'}],idempotencyKey:'stable-key'});
  assert.equal(calls[0][2].members[0].sourceAssetId,'library-id');assert.equal(calls[0][2].idempotencyKey,'stable-key');
  await l.updateRole('role',{name:'Character',members:[{assetId:'member-id'}]},'2026-09-10T04:02:58.517258Z');assert.equal(calls[1][2].expectedRevision,'2026-09-10T04:02:58.517258Z');
  const s=roleSnapshot({element_id:'r',revision:'exact',name:'Role',assets:[{asset_id:'member',asset_type:'ASSET_TYPE_IMAGE'}]});assert.equal(s.assets[0].id,'member');
});
