// Run with Vite on 5173 and an isolated headless Chrome on debugging port 9229.
// Requires Node 22+ (native WebSocket). All API responses and images are synthetic.
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
const target = await (await fetch('http://127.0.0.1:9229/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener('open', r, { once: true }));
let seq = 0;
const pending = new Map();
const errors = [];
ws.addEventListener('message', ({ data }) => {
  const msg = JSON.parse(data);
  if (msg.method === 'Runtime.exceptionThrown') errors.push(msg.params.exceptionDetails.text);
  const call = pending.get(msg.id);
  if (call) { pending.delete(msg.id); msg.error ? call.reject(msg.error) : call.resolve(msg.result); }
});
function send(method, params = {}) {
  return new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method, params })); });
}
async function evaluate(expression) {
  const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
async function until(expression) {
  for (let i = 0; i < 150; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Timed out: ' + expression + '\n' + await evaluate('document.body.innerText'));
}
async function click(text) {
  await evaluate(`(() => { const b = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === ${JSON.stringify(text)}); if (!b || b.disabled) throw new Error('Missing/disabled: ${text}'); b.click(); })()`);
}
try {
await send('Runtime.enable');
await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1536, height: 1100, deviceScaleFactor: 1, mobile: false });
await send('Page.addScriptToEvaluateOnNewDocument', { source: `
window.__posts = []; window.__attempts = 0; window.__apiRequests = [];
const realFetch = window.fetch.bind(window);
window.fetch = async (url, init) => {
  if (!String(url).startsWith('/api/')) return realFetch(url, init);
  window.__apiRequests.push(String(url));
  if (url === '/api/images/regenerate') {
    if (!init) return Response.json({ enabled: true });
    const img = await createImageBitmap(init.body.get('file'));
    const input = document.createElement('canvas'); input.width = img.width; input.height = img.height;
    const ctx = input.getContext('2d'); ctx.drawImage(img, 0, 0);
    window.__generationPixels = [80, 550].map(x => [...ctx.getImageData(x, 130, 1, 1).data]);
    window.__attempts++;
    window.__generationBoxes = JSON.parse(init.body.get('boxes'));
    if (window.__attempts === 1) return Response.json({detail:'합성 생성 실패'}, {status:502});
    const c = document.createElement('canvas'); c.width = 200; c.height = 150;
    const x = c.getContext('2d'); x.fillStyle = '#55bb66'; x.fillRect(0,0,200,150);
    const patch = c.toDataURL('image/png').split(',')[1];
    return Response.json({ patches: window.__generationBoxes.map(() => patch) });
  }
  if (url === '/api/posts' && init) {
    window.__posts.push(init.body);
    return Response.json({post_id: 'p' + window.__posts.length});
  }
  if (String(url).endsWith('/report')) return Response.json({post_id:'p1',status:'AWAITING_USER',risk_before:window.__posts.length === 1 ? .8 : .1,risk_after:null,items:[{position:0,job_id:'j1',input_type:'image',status:'AWAITING_USER',risk_before:.8,risk_after:null,findings:window.__posts.length === 1 ? [
    {type:'address',source:'ocr',title:'택배 송장',bbox:[70,100,290,190],risk_level:'high',action:'mask'},
    {type:'face',source:'vlm',title:'사람 얼굴',bbox:[340,120,460,260],action:'blur'},
    {type:'reflection',source:'vlm',title:'창문 반사',bbox:[500,70,750,270],action:'mask'}
  ]:[],details:{}}]});
  throw new Error('Unexpected API call: '+url);
};
window.EventSource = class {
  constructor() { this.closed=false; }
  addEventListener(name, f) { if(name === 'awaiting_user') setTimeout(() => { if(!this.closed) f({data:JSON.stringify({status:'AWAITING_USER',items:[]})}); }, 20); }
  close() { this.closed=true; }
};
` });
await send('Page.navigate', { url: 'http://127.0.0.1:5173' });
await until(`!!document.querySelector('.hero-actions')`);
await click('예시로 먼저 둘러보기');
await until(`document.querySelector('.editor-grid') && !document.querySelector('.render-badge')`);
assert.equal(await evaluate(`document.querySelectorAll('.region-row').length`), 3);
assert.ok((await evaluate(`document.body.innerText`)).includes('화면 데모'));
assert.deepEqual(await evaluate(`window.__apiRequests`), []);
await evaluate(`document.querySelectorAll('.region-row')[2].click()`);
assert.equal(await evaluate(`document.querySelector('.generation-panel button').disabled`), true);
assert.equal(await evaluate(`document.querySelector('.editor-grid').children.length`), 2);
const demoScreenshot = await send('Page.captureScreenshot', {format:'png',captureBeyondViewport:true});
await writeFile('/tmp/odyssey-editor-demo.png', Buffer.from(demoScreenshot.data,'base64'));
await click('적용');
await until(`!!document.querySelector('.share-card')`);
assert.deepEqual(await evaluate(`window.__apiRequests`), []);
await click('편집으로 돌아가기');
await until(`document.querySelectorAll('.region-row').length === 3 && !document.querySelector('.render-badge')`);
await click('적용');
await until(`!!document.querySelector('.share-card')`);
await click('새 게시물 보호하기');
await until(`!!document.querySelector('.hero-actions')`);
await click('바로 보호 편집하기');
await until(`!!document.querySelector('input[type=file]')`);
await evaluate(`(async () => {
  const c = document.createElement('canvas'); c.width=800; c.height=600;
  const x=c.getContext('2d'); x.fillStyle='#edf2e4';x.fillRect(0,0,800,600);
  for(let y=0;y<600;y+=10) for(let z=0;z<800;z+=10) { x.fillStyle=(z+y)%20?'#c7d4b4':'#edf2e4';x.fillRect(z,y,10,10); }
  x.fillStyle='#172b47';x.font='30px sans-serif';x.fillText('SYNTHETIC ADDRESS',75,155);
  const file = new File([await new Promise(r => c.toBlob(r))], 'synthetic.png', {type:'image/png'});
  const dt=new DataTransfer();dt.items.add(file);const input=document.querySelector('input[type=file]');input.files=dt.files;input.dispatchEvent(new Event('change',{bubbles:true}));
})()`);
await until(`!!document.querySelector('.photo-thumb') || [...document.querySelectorAll('button')].some(b => b.textContent.includes('보호') && !b.disabled)`);
await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='노출 단서 찾기' && !b.disabled)`);
await click('노출 단서 찾기');
await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='추천 보호안 보기')`);
await click('추천 보호안 보기');
await until(`document.querySelector('.editor-grid') && !document.querySelector('.render-badge') && document.querySelector('.photo-view image').getAttribute('href').startsWith('blob:')`);
const enabled = () => evaluate(`[...document.querySelectorAll('.edit-actions button')].filter(b=>!b.disabled).map(b=>b.textContent.trim())`);
assert.deepEqual(await enabled(), ['가림','블러','부분마스킹','텍스트제거']);
await evaluate(`document.querySelectorAll('.region-row')[1].click()`);
assert.deepEqual(await enabled(), ['가림','블러','모자이크']);
await click('모자이크');
await until(`!document.querySelector('.render-badge')`);
assert.equal(await evaluate(`document.querySelectorAll('.editor input[type=range]').length`), 0);
// 사용자가 바꾼 편집(A 영역 그대로 두기)은 재생성 입력에 들어가지 않는다: A는 처음 추천대로 가려진 채 간다.
await evaluate(`document.querySelectorAll('.region-row')[0].click()`);
await evaluate(`document.querySelector('.skip-option input').click()`);
await until(`!document.querySelector('.render-badge')`);
for (const i of [0, 1, 2]) {
  await evaluate(`document.querySelectorAll('.region-row')[${i}].click()`);
  assert.equal(await evaluate(`!!document.querySelector('.image-workspace .generation-panel button')`), true, 'one regeneration panel for the whole photo');
}
assert.ok((await evaluate(`document.querySelector('.generation-panel').textContent`)).includes('영역 2개 한 번에'), 'kept region A is not regenerated');
await evaluate(`document.querySelectorAll('.region-row')[2].click()`);
assert.deepEqual(await enabled(), ['가림']);
assert.equal(await evaluate(`!!document.querySelector('.image-workspace .generation-panel') && !document.querySelector('.controls-card .generation-panel')`), true, 'regeneration sits under the photo');
assert.ok((await evaluate(`document.querySelector('.generation-panel').textContent`)).includes('추천에 들어가지 않아요'));
await until(`[...document.querySelectorAll('.generation-panel button')].some(b=>!b.disabled)`);
for(let i=0;i<3;i++) {
  await evaluate(`{ const button = document.querySelector('.generation-panel button'); button.click(); button.click(); }`);
  await until(`window.__attempts === ${i+1} && !document.querySelector('fieldset').disabled && !document.querySelector('.render-badge')`);
  assert.deepEqual(await evaluate(`window.__generationPixels`), [[20,33,56,255],[20,33,56,255]], 'generation receives the first AI-protected pixels, not user edits');
  assert.equal(await evaluate(`window.__generationBoxes.length`), i === 0 ? 2 : 3, 'all regions of the photo go in one call');
  if (i === 0) {
    assert.equal(await evaluate(`document.querySelector('.control-footer .primary').disabled`), false, 'generation failure does not block ordinary editing');
    await evaluate(`document.querySelector('.undo-button').click()`);
    await until(`!document.querySelector('.render-badge')`);
    assert.ok((await evaluate(`document.querySelector('.generation-panel button').textContent`)).includes('1 / 3'));
  }
}
assert.equal(await evaluate(`document.querySelector('.generation-panel button').disabled`), true);
await evaluate(`document.querySelectorAll('.journey button')[2].click()`);
await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='추천 보호안 보기')`);
await click('추천 보호안 보기');
await until(`!!document.querySelector('.editor-grid') && !document.querySelector('.render-badge')`);
await evaluate(`document.querySelectorAll('.region-row')[2].click()`);
await until(`!!document.querySelector('.generation-panel button')`);
assert.equal(await evaluate(`document.querySelector('.generation-panel button').disabled`), true);
assert.ok((await evaluate(`document.querySelector('.generation-panel button').textContent`)).includes('3 / 3'));
assert.equal(await evaluate(`window.__attempts`), 3);

await evaluate(`document.querySelectorAll('.region-row')[0].click()`);
const rect = await evaluate(`(() => { const r=document.querySelector('.photo-view g[role=button] rect').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height}; })()`);
await send('Input.dispatchMouseEvent',{ type:'mousePressed',x:rect.x,y:rect.y,button:'left',clickCount:1 });
await send('Input.dispatchMouseEvent',{ type:'mouseMoved',x:rect.x+rect.w*.6,y:rect.y,button:'left',buttons:1 });
await send('Input.dispatchMouseEvent',{ type:'mouseReleased',x:rect.x+rect.w*.6,y:rect.y,button:'left',clickCount:1 });
const boxAttributes = () => evaluate(`(() => { const r=document.querySelector('.photo-view g[role=button] rect');return ['x','y','width','height'].map(n=>+r.getAttribute(n)); })()`);
const before = await boxAttributes();
assert.deepEqual(before, [70,100,220,90], 'dragging cannot move the box');
assert.equal(await evaluate(`!!document.querySelector('.editor-warning')`), false);
assert.equal(await evaluate(`[...document.querySelectorAll('button')].some(b=>['블러 추가','선택 영역 삭제','스티커','배경 복원'].includes(b.textContent.trim()))`), false);
const handle = await evaluate(`(() => { const r=document.querySelectorAll('.resize-handle')[2].getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}; })()`);
await send('Input.dispatchMouseEvent',{type:'mousePressed',x:handle.x,y:handle.y,button:'left',clickCount:1});
await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:handle.x+rect.w*.25,y:handle.y+rect.h*.25,button:'left',buttons:1});
await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:handle.x+rect.w*.25,y:handle.y+rect.h*.25,button:'left',clickCount:1});
await until(`!document.querySelector('.render-badge')`);
const after = await boxAttributes();
assert.ok(Math.abs(before[2]/before[3]-after[2]/after[3])<1e-9);
assert.ok(Math.abs(before[0]+before[2]/2-after[0]-after[2]/2)<1e-9);
assert.ok(Math.abs(before[1]+before[3]/2-after[1]-after[3]/2)<1e-9);
assert.ok(Math.abs(after[2]-before[2]*1.5)<1, 'corner drag scales around center');
await evaluate(`document.querySelectorAll('.resize-handle')[2].dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowLeft',shiftKey:true,bubbles:true}))`);
assert.ok((await boxAttributes())[2]<after[2], 'keyboard can shrink from a corner');
await click('부분마스킹');
await until(`!document.querySelector('.render-badge')`);
assert.equal(await evaluate(`document.querySelectorAll('.editor input[type=range]').length`),0);
assert.equal(await evaluate(`document.querySelector('.control-footer .primary').disabled`),true,'no implicit central mask');
const part = await evaluate(`(() => { const r=document.querySelector('.photo-view g[aria-pressed=true] rect').getBoundingClientRect(); return {x:r.x+r.width*.1,y:r.y+r.height*.2,x2:r.x+r.width*.4,y2:r.y+r.height*.8}; })()`);
await send('Input.dispatchMouseEvent',{type:'mousePressed',x:part.x,y:part.y,button:'left',clickCount:1});
await send('Input.dispatchMouseEvent',{type:'mouseMoved',x:part.x2,y:part.y2,button:'left',buttons:1});
await send('Input.dispatchMouseEvent',{type:'mouseReleased',x:part.x2,y:part.y2,button:'left',clickCount:1});
await until(`!document.querySelector('.render-badge') && !document.querySelector('.control-footer .primary').disabled`);
// Keyboard selection can specify both corners without any predefined percentage.
await evaluate(`(async () => { for(const key of ['Enter','ArrowRight','ArrowDown','Enter','ArrowRight','ArrowDown','Enter']) {document.querySelector('.photo-view g[aria-pressed=true]').dispatchEvent(new KeyboardEvent('keydown',{key,shiftKey:true,bubbles:true}));await new Promise(r=>setTimeout(r,0));} })()`);
await until(`!document.querySelector('.render-badge')`);
assert.deepEqual(await evaluate(`(async () => { const r=document.querySelector('.photo-view g[aria-pressed=true] rect'); const img=await createImageBitmap(await(await fetch(document.querySelector('.photo-view image').getAttribute('href'))).blob());const c=document.createElement('canvas');c.width=img.width;c.height=img.height;const ctx=c.getContext('2d');ctx.drawImage(img,0,0);return [...ctx.getImageData(+r.getAttribute('x')+15,+r.getAttribute('y')+15,1,1).data]; })()`),[20,33,56,255]);
await evaluate(`document.querySelector('.delete-box').dispatchEvent(new MouseEvent('click',{bubbles:true}))`);
await until(`document.querySelectorAll('.region-row').length === 2 && !document.querySelector('.render-badge')`);
assert.equal(await evaluate(`document.querySelector('.region-list').textContent.includes('택배 송장')`),false);
await evaluate(`document.querySelector('.undo-button').click()`);
await until(`document.querySelectorAll('.region-row').length === 3 && !document.querySelector('.render-badge')`);
assert.deepEqual(await boxAttributes(), before, 'reset restores deleted box and original dimensions');
await evaluate(`document.querySelectorAll('.region-row')[2].click()`);
await until(`!!document.querySelector('.generation-panel button') && !document.querySelector('.render-badge')`);
assert.ok((await evaluate(`document.querySelector('.generation-panel button').textContent`)).includes('3 / 3'));
assert.equal(await evaluate(`document.querySelector('.generation-panel button').disabled`),true);
await click('가림');
await evaluate(`document.querySelectorAll('.region-row')[0].click()`);
await click('텍스트제거');
await until(`!document.querySelector('.render-badge') && document.querySelector('.edit-actions button[aria-pressed=true]')?.textContent === '텍스트제거'`);
assert.equal(await evaluate(`!!document.querySelector('.editor-warning')`),false);
await click('가림');
await until(`!document.querySelector('.render-badge')`);
const desktop = await send('Page.captureScreenshot', { format:'png', captureBeyondViewport:true });
await writeFile('/tmp/odyssey-editor-desktop.png', Buffer.from(desktop.data,'base64'));
await send('Emulation.setDeviceMetricsOverride',{width:390,height:844,deviceScaleFactor:1,mobile:true});
await new Promise(r=>setTimeout(r,200));
assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true);
const mobile = await send('Page.captureScreenshot',{format:'png',captureBeyondViewport:true});
await writeFile('/tmp/odyssey-editor-mobile.png',Buffer.from(mobile.data,'base64'));
await send('Emulation.setDeviceMetricsOverride',{width:1536,height:1100,deviceScaleFactor:1,mobile:false});
await until(`!document.querySelector('.render-badge')`);
await evaluate(`(async () => { window.__preview = await (await fetch(document.querySelector('.photo-view image').getAttribute('href'))).arrayBuffer(); })()`);
await click('적용');
await until(`!!document.querySelector('.verification-card')`);
assert.equal(await evaluate(`window.__posts.length`),2);
assert.equal(await evaluate(`(async()=>{const a=new Uint8Array(window.__preview),b=new Uint8Array(await window.__posts[1].get('files').arrayBuffer());return a.length===b.length&&a.every((v,i)=>v===b[i]);})()`),true);
assert.equal(await evaluate(`!!document.querySelector('.alert.error')`),false);
assert.deepEqual(errors,[]);
const pixelResults = await evaluate(`(async () => {
  const { renderPhoto } = await import('/src/media.ts');
  const canvas = document.createElement('canvas'); canvas.width=100;canvas.height=80;
  const ctx=canvas.getContext('2d');ctx.fillStyle='#00ff00';ctx.fillRect(0,0,100,80);
  ctx.fillStyle='#ff0000';ctx.fillRect(20,20,40,20);
  const photo={url:canvas.toDataURL(),width:100,height:80};
  const clue={kind:'image',bbox:[20,20,60,40]};
  async function pixels(action, extra={}) {
    const blob=await renderPhoto(photo,[{...clue,action,...extra}]);
    const bitmap=await createImageBitmap(blob);ctx.clearRect(0,0,100,80);ctx.drawImage(bitmap,0,0);
    return {outside:[...ctx.getImageData(5,5,1,1).data],left:[...ctx.getImageData(21,25,1,1).data],center:[...ctx.getImageData(40,25,1,1).data]};
  }
  const results={};
  for(const action of ['mask','blur','mosaic','partialMask','remove','skip']) results[action]=await pixels(action,action==='partialMask'?{maskBox:[.25,0,.75,1]}:{});
  results.leftMask=await pixels('partialMask',{maskBox:[0,0,.25,1]});
  results.deleted=await pixels('mask',{deleted:true});
  let rejected=false;try {await pixels('partialMask');}catch{rejected=true;}if(!rejected)throw new Error('missing partial selection must not export');
  return results;
})()`);
for (const value of Object.values(pixelResults)) assert.deepEqual(value.outside,[0,255,0,255]);
assert.deepEqual(pixelResults.mask.center,[20,33,56,255]);
assert.deepEqual(pixelResults.partialMask.left,[255,0,0,255]);
assert.deepEqual(pixelResults.partialMask.center,[20,33,56,255]);
assert.deepEqual(pixelResults.leftMask.left,[20,33,56,255]);
assert.deepEqual(pixelResults.leftMask.center,[255,0,0,255]);
assert.deepEqual(pixelResults.deleted.center,[255,0,0,255]);
assert.deepEqual(pixelResults.remove.center,[0,255,0,255]);
assert.deepEqual(pixelResults.skip.center,[255,0,0,255]);
console.log('PASS: original two-column layout, offline demo, exact category tools, direct corner resizing, fixed center/aspect, X deletion/reset, user-drawn partial masking, no sliders/movement, independent generation with protected input and failure recovery, generation cap, mobile layout, preview/export equality, browser inpainting and effect pixels.');
} finally {
  await send('Page.close').catch(() => {});
  ws.close();
}
