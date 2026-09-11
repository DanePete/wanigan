#!/usr/bin/env node
// Real renderer in isolated Electron. Every record and action below is synthetic.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require=createRequire(import.meta.url),{_electron}=require('playwright-core');
const root=path.resolve(import.meta.dirname,'..'),before=process.argv.includes('--before');
const out=path.join(root,'docs/visuals/skills-workspace',before?'before':'after');
mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-skills-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const checks=[],errors=[],dimensions=[];
const record=text=>{checks.push(text);console.log(text);};
try {
 const page=await app.firstWindow();page.setDefaultTimeout(15000);
 const archiveAt=process.argv.indexOf('--archive');
 if(archiveAt>=0){const archive=process.argv[archiveAt+1],asar=require('@electron/asar');await page.route(rendererURL.replace('/index.html','/**'),route=>{const name='out/renderer'+new URL(route.request().url()).pathname;return route.fulfill({body:asar.extractFile(archive,name),contentType:({'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'})[path.extname(name)]??'application/octet-stream'});});}
 page.on('pageerror',e=>errors.push(e.message));await page.emulateMedia({reducedMotion:'reduce'});
 await page.addInitScript(STUB);
 await page.addInitScript(()=>{
  const original=window.wanigan,now=Date.now();window.__skillCalls=[];window.__skillReads=[];
  const skill=(name,description,source,projectId=null)=>({name,label:name,description,source,projectId,harness:'claude-code',path:'/example/'+(projectId??source)+'/.claude/skills/'+name+'/SKILL.md',dir:'/example/'+(projectId??source)+'/.claude/skills/'+name,invoke:'/'+name,plugin:source==='plugin'?'workbench':null,marketplace:source==='plugin'?'team-tools':null,allowedTools:source==='project'?['Read','Bash']:[],extras:source==='project'?3:0,bytes:1640,modified:now-7200000,invocable:{user:true,model:true},projection:null});
  window.__skillRows=[skill('verification-before-completion','Check the behavior you changed and record the evidence before handing work back.','user'),skill('review-checkout','Review retries, payment boundaries and the order confirmation flow.','project','p1'),skill('component-craft','Shape a deliberate interface with accessible controls and thoughtful motion.','plugin'),skill('trace-request','Follow one request from the route to its data boundary.','user'),skill('compact','Summarize the useful context before continuing a long session.','builtin'),skill('query-contract','Verify the search ranking contract before changing the index.','project','p2')];
  window.__skillBodies={};for(const s of window.__skillRows)window.__skillBodies[s.path]='---\nname: '+s.name+'\ndescription: '+s.description+'\n---\n\n# '+s.name+'\n\n## When to use\n\n'+s.description+'\n\n## Workflow\n\n1. Inspect the relevant changes and their callers.\n2. Check the behavior at the boundary.\n3. Run the focused verification and record its outcome.\n\n## Verification\n\nThe handoff names the checks that ran and any remaining uncertainty.\n';
  window.__skillCatalog=id=>{const skills=window.__skillRows.filter(s=>!s.projectId||s.projectId===id);const counts={user:0,project:0,plugin:0,builtin:0};skills.forEach(s=>counts[s.source]++);return {skills,counts,roots:Object.keys(counts).map(source=>({source,path:source==='project'?(id?'/example/'+id+'/.claude/skills':'—'):'/example/'+source+'/.claude/skills',exists:source!=='project'||!!id,note:source==='builtin'?'Only extracted built-ins are shown; this is not the complete bundled set.':null})),agentSkills:[],agentRoots:[],shadowed:[],scannedAt:Date.now()};};
  window.wanigan=new Proxy(original,{get(api,service){
   if(service==='skills')return {list:async id=>{window.__skillReads.push(['list',id]);if(window.__scanFailure)throw new Error('Fixture directory cannot be read');const value=window.__skillCatalog(id);if(window.__holdScan===id)return new Promise(resolve=>window.__releaseScan=()=>resolve(value));return structuredClone(value);},refresh:async()=>{window.__skillReads.push(['refresh']);return true;},body:async path=>{window.__skillReads.push(['body',path]);if(window.__bodyFailure===path)throw new Error('Fixture skill file was moved');const value={text:window.__skillBodies[path]??'# New skill',truncated:!!window.__truncated,bytes:window.__truncated?250000:1640};if(window.__holdBody===path)return new Promise(resolve=>window.__releaseBody=()=>resolve(value));return value;},send:async(...args)=>{window.__skillCalls.push(['send',...args]);if(window.__sendFailure)throw new Error('Selected harness does not support this invocation');if(window.__holdSend)await new Promise(resolve=>window.__releaseSend=resolve);return true;}};
   if(service==='learning')return new Proxy(api.learning,{get(learning,method){
    if(method==='forgeSkill')return async input=>{window.__skillReads.push(['forge',input]);if(window.__forgeFailure)throw new Error('Fixture draft could not be built');const value={name:input.name,scope:input.scope,skillMd:'---\nname: '+input.name+'\ndescription: '+input.description+'\n---\n\n# '+input.name+'\n\n## When to use\n'+input.trigger+'\n\n## Workflow\n'+input.steps.map((s,i)=>(i+1)+'. '+s.instruction).join('\n')+'\n\n## Verification\n'+input.verification.join('\n'),allowedTools:[],providerIds:input.providerIds,estimatedTokens:142};if(window.__holdForge)return new Promise(resolve=>window.__releaseForge=()=>resolve(value));return value;};
    if(method==='doctorSkill')return async()=>{window.__skillReads.push(['doctor']);return window.__diagnostics??[];};
    if(method==='installSkill')return async(...args)=>{window.__skillCalls.push(['install',...args]);if(window.__installFailure)throw new Error('Fixture write refused');if(window.__holdInstall)await new Promise(resolve=>window.__releaseInstall=resolve);return args[1].map(id=>({providerId:id,error:window.__partialInstall&&id==='codex'?'Fixture provider directory is read-only':null,projection:{targetPath:'/example/'+(args[2]??'personal')+'/'+(id==='codex'?'.agents':'.claude')+'/skills/'+args[0].name+'/SKILL.md'}}));};
    return learning[method];
   }});
   if(service==='browse')return {...api.browse,reveal:async path=>{window.__skillCalls.push(['reveal',path]);if(window.__revealFailure)throw new Error('Fixture folder unavailable');}};
   return api[service];
  }});
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{window.__skillCalls.push(['copy',text]);if(window.__copyFailure)throw new Error('Fixture clipboard unavailable');}}});
 });
 await page.goto(rendererURL);await page.locator('.mission-room').waitFor();
 await page.locator('.space-dock button').first().focus();await page.keyboard.press('Meta+Shift+s');await page.getByRole('heading',{name:'Skills',exact:true}).waitFor();
 await page.getByRole('combobox',{name:"Which repository's project skills to include",exact:true}).selectOption('p1');
 await page.waitForFunction(()=>document.querySelector('.skills-view')?.textContent.includes('verification-before-completion'));
 const capture=async name=>{await page.evaluate(()=>document.activeElement?.blur());for(const theme of ['dark','light']){await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);await page.screenshot({path:path.join(out,`${name}-${theme}.png`),scale:'css'});}};
 await capture('library');
 if(before){
  await page.getByRole('button',{name:'verification-before-completion',exact:true}).click();await page.locator('.skills-md').waitFor();await capture('reader');
  await page.locator('.skills-reader').getByTitle('Close the reading pane',{exact:true}).click();
  await page.getByRole('button',{name:'Write a skill',exact:true}).click();await page.locator('#skills-writer').scrollIntoViewIfNeeded();await capture('writer');
  await page.getByRole('heading',{name:'Where these came from'}).scrollIntoViewIfNeeded();await capture('sources');
 }else{
  const area=async name=>page.getByRole('group',{name:'Skills workspace',exact:true}).getByRole('button',{name,exact:true}).click();
  const scope=page.getByRole('combobox',{name:"Which repository's project skills to include",exact:true});
  const reader=page.locator('.skills-reader');
  const choose=async name=>{await page.locator('.skills-entry').filter({has:page.getByText(name,{exact:true})}).click();await page.waitForFunction(name=>document.querySelector('.skills-reader h2')?.textContent===name,name);};
  const waitText=async(selector,text)=>page.waitForFunction(({selector,text})=>document.querySelector(selector)?.textContent.includes(text),{selector,text});
  const calls=()=>page.evaluate(()=>window.__skillCalls);
  const readerArea=async name=>reader.getByRole('group',{name:'Skill reader section'}).getByRole('button',{name,exact:true}).click();
  const search=page.getByRole('combobox',{name:'Search skills by name or description'});
  assert.deepEqual(await calls(),[]);
  await reader.locator('.skills-md').waitFor();await capture('reader');
  await choose('review-checkout');await readerArea('Details');await waitText('.skills-details','Read');await capture('details');
  await area('Sources');await page.getByRole('heading',{name:'Where these came from'}).waitFor();await capture('sources');
  await area('Library');await waitText('.skills-reader','review-checkout');assert.equal(await reader.getByRole('button',{name:'Details',exact:true}).getAttribute('aria-pressed'),'true');await readerArea('SKILL.md');
  await search.fill('vbc');await page.waitForFunction(()=>document.querySelectorAll('.skills-entry').length===1);assert.equal(await page.locator('.skills-entry mark').allTextContents().then(a=>a.join('')),'vbc');
  await search.press('ArrowDown');assert(await search.getAttribute('aria-activedescendant'));await search.press('Enter');assert(await search.evaluate(el=>el===document.activeElement));await waitText('.skills-reader','verification-before-completion');await capture('search');
  await page.getByRole('button',{name:'Clear filters',exact:true}).click();await page.locator('.skills-filters').getByRole('button',{name:/plugin/}).click();assert.equal(await page.locator('.skills-entry').count(),1);
  await search.fill('vbc');await waitText('.skills-directory','Sources hide every match');await page.locator('.skills-count').getByRole('button',{name:'Clear filters'}).click();
  await search.fill('zqzqzq');await waitText('.skills-directory','No skill matches this search');await capture('no-match');await page.locator('.skills-count').getByRole('button',{name:'Clear filters'}).click();
  await page.getByRole('group',{name:'Skills workspace',exact:true}).getByRole('button',{name:'Library',exact:true}).focus();await page.keyboard.press('ArrowRight');assert.equal(await page.getByRole('group',{name:'Skills workspace'}).getByRole('button',{name:'Write',exact:true}).getAttribute('aria-pressed'),'true');await area('Library');
  record('Search keeps visible match ranking, source facets and keyboard typeahead; selection and reader sections survive workspace navigation.');

  const firstPath=await page.evaluate(()=>window.__skillRows[0].path),secondPath=await page.evaluate(()=>window.__skillRows[1].path);
  await page.evaluate(path=>window.__holdBody=path,firstPath);await choose('review-checkout');await choose('verification-before-completion');await page.waitForFunction(()=>!!window.__releaseBody);await choose('trace-request');await page.evaluate(()=>{window.__releaseBody();window.__holdBody=null;});await waitText('.skills-md','# trace-request');assert.doesNotMatch(await page.locator('.skills-md').innerText(),/# verification-before-completion/);
  await page.evaluate(path=>window.__bodyFailure=path,secondPath);await choose('review-checkout');await waitText('.skills-reader','Fixture skill file was moved');await capture('read-unavailable');await page.evaluate(()=>window.__bodyFailure=null);await reader.getByRole('button',{name:'Retry reading'}).click();await page.locator('.skills-md').waitFor();
  await page.evaluate(()=>window.__truncated=true);await page.getByRole('button',{name:'Rescan disk'}).click();await waitText('.skills-reader','Showing the first 200 KB');await capture('truncated');await page.evaluate(()=>window.__truncated=false);
  record('Delayed file reads cannot replace the selected skill; read failures have Retry and truncated files remain explicitly labelled.');

  await page.evaluate(()=>window.__holdScan='p2');await scope.selectOption('p2');await waitText('.skills-scroll','Reading skill directories');assert.equal(await page.locator('.skills-entry').count(),0);await scope.selectOption('p1');await page.locator('.skills-entry').first().waitFor();await page.evaluate(()=>{window.__releaseScan();window.__holdScan=null;});assert.equal(await page.locator('.skills-entry').filter({hasText:'query-contract'}).count(),0);
  await scope.selectOption('');assert.equal(await page.locator('.skills-entry').filter({hasText:'review-checkout'}).count(),0);await scope.selectOption('p1');await page.locator('.skills-entry').filter({hasText:'review-checkout'}).waitFor();
  await page.evaluate(()=>window.__scanFailure=true);await page.getByRole('button',{name:'Rescan disk'}).click();await waitText('.skills-scroll','last successful scan is still shown');assert.equal(await reader.getByRole('button',{name:'Type into session'}).count(),0);await capture('scan-unavailable');await page.evaluate(()=>window.__scanFailure=false);await page.getByRole('button',{name:'Scan again',exact:true}).click();await page.waitForFunction(()=>!document.querySelector('.skills-scroll').textContent.includes('last successful scan is still shown'));
  record('Project changes clear old records immediately; a failed rescan keeps dated records and removes session typing until the scan succeeds.');

  await choose('verification-before-completion');await reader.getByRole('button',{name:'Copy invocation',exact:true}).click();assert.deepEqual((await calls()).at(-1),['copy','/verification-before-completion']);
  await page.evaluate(()=>window.__copyFailure=true);await reader.getByRole('button',{name:'Copy invocation'}).click();await waitText('.skills-view','clipboard could not be written');await page.evaluate(()=>window.__copyFailure=false);
  await reader.getByRole('button',{name:'Reveal folder'}).click();assert.equal((await calls()).at(-1)[0],'reveal');
  await page.evaluate(()=>window.__holdSend=true);let n=(await calls()).length;await reader.getByRole('button',{name:'Type into session'}).click();await page.waitForFunction(()=>!!window.__releaseSend);assert(await reader.getByRole('button',{name:'Typing…'}).isDisabled());assert.equal((await calls()).length,n+1);await page.evaluate(()=>{window.__holdSend=false;window.__releaseSend();});await waitText('.skills-view','It is not submitted');assert.equal((await calls()).at(-1)[0],'send');
  await page.evaluate(()=>window.__sendFailure=true);await reader.getByRole('button',{name:'Type into session'}).click();await waitText('.skills-view','Selected harness does not support');await page.evaluate(()=>window.__sendFailure=false);
  record('Copy, reveal and session typing require deliberate actions; typing is serialized, stays unsubmitted and reports the main process refusal.');

  if(await page.getByRole('button',{name:'Dismiss',exact:true}).count())await page.getByRole('button',{name:'Dismiss',exact:true}).click();
  await area('Write');await capture('writer');const form=page.locator('.skills-writer-form'),preview=page.locator('.skills-writer-preview');
  const build=()=>form.getByRole('button',{name:'Build the SKILL.md',exact:true}).click();
  await form.getByRole('textbox',{name:'Skill name',exact:true}).fill('verify-checkout');await form.getByRole('textbox',{name:'Description',exact:true}).fill('Verify the checkout retry boundary.');await form.getByRole('textbox',{name:'Trigger',exact:true}).fill('When changing payment callbacks or retry handling.');await form.getByRole('combobox',{name:'Where it lives',exact:true}).selectOption('project');
  await page.evaluate(()=>window.__holdForge=true);await build();await page.waitForFunction(()=>!!window.__releaseForge);await form.getByRole('textbox',{name:'Description',exact:true}).fill('Verify retry identity before a release.');await page.evaluate(()=>{window.__holdForge=false;window.__releaseForge();});await waitText('.skills-writer-preview','No draft yet');assert.equal(await preview.getByRole('button',{name:/Write .* to disk/}).count(),0);
  await page.evaluate(()=>window.__forgeFailure=true);await build();await waitText('.skills-writer-preview','draft could not be built');await page.evaluate(()=>{window.__forgeFailure=false;window.__diagnostics=[{code:'missing-proof',severity:'error',message:'The fixture requires a verification step.'}];});await build();await waitText('.skills-writer-preview','missing-proof');assert(await preview.getByRole('button',{name:'Write verify-checkout to disk'}).isDisabled());await capture('blocked-draft');
  await page.evaluate(()=>window.__diagnostics=[]);await build();await preview.locator('.skills-writer-md').waitFor();n=(await calls()).length;await page.locator('.skills-scroll').evaluate(el=>el.scrollTop=0);await capture('preview');assert.match(await preview.locator('.skills-writer-md').innerText(),/Verify retry identity before a release/);
  await area('Library');await area('Write');assert.equal(await form.getByRole('textbox',{name:'Skill name',exact:true}).inputValue(),'verify-checkout');assert.equal((await calls()).length,n);
  await form.getByRole('checkbox',{name:'Codex',exact:true}).uncheck();assert.equal(await preview.getByRole('button',{name:/Write .* to disk/}).count(),0);await form.getByRole('checkbox',{name:'Codex',exact:true}).check();await build();await preview.locator('.skills-writer-md').waitFor();
  record('Authoring keeps its draft across sections; editing or changing targets invalidates previews, late builds are discarded and error diagnostics block installation.');

  await page.evaluate(()=>window.__partialInstall=true);n=(await calls()).length;const exact=await preview.locator('.skills-writer-md').innerText();await preview.getByRole('button',{name:'Write verify-checkout to disk'}).click();await waitText('.skills-writer-preview','Fixture provider directory is read-only');let write=(await calls()).at(-1);assert.equal(write[0],'install');assert.equal(write[1].skillMd,exact);assert.deepEqual(write[2],['claude','codex']);assert.equal(write[3],'p1');await capture('partial-install');
  await page.evaluate(()=>window.__installFailure=true);await preview.getByRole('button',{name:'Retry failed providers'}).click();await waitText('.skills-writer-preview','The write did not complete');assert.match(await preview.innerText(),/claude.*SKILL.md/);assert.deepEqual((await calls()).at(-1)[2],['codex']);
  await page.evaluate(()=>{window.__installFailure=false;window.__partialInstall=false;window.__holdInstall=true;});await preview.getByRole('button',{name:'Retry failed providers'}).click();await page.waitForFunction(()=>!!window.__releaseInstall);assert(await preview.getByRole('button',{name:'Writing…'}).isDisabled());assert(await form.getByRole('textbox',{name:'Skill name'}).isDisabled());write=(await calls()).at(-1);assert.deepEqual(write[2],['codex']);await page.evaluate(()=>{window.__holdInstall=false;window.__releaseInstall();});await preview.getByRole('button',{name:'Installed',exact:true}).waitFor();assert(await preview.getByRole('button',{name:'Installed'}).isDisabled());await capture('installed');assert.equal((await calls()).length,n+3);
  record('Install uses the reviewed bytes and project; partial receipts stay visible, retries target only failed providers and duplicate writes are disabled.');

  await scope.selectOption('p2');await page.locator('.skills-writer-form').waitFor();assert.equal(await form.getByRole('textbox',{name:'Skill name'}).inputValue(),'');await scope.selectOption('p1');assert.equal(await form.getByRole('textbox',{name:'Skill name'}).inputValue(),'verify-checkout');assert.equal(await preview.getByRole('button',{name:/Write .* to disk/}).count(),0);
  await page.locator('.space-dock').getByRole('button',{name:'Mission room',exact:true}).click();await page.locator('.mission-room').waitFor();await page.keyboard.press('Meta+Shift+s');await form.waitFor();assert.equal(await form.getByRole('textbox',{name:'Skill name'}).inputValue(),'verify-checkout');assert.equal(await scope.inputValue(),'p1');
  record('Writer inputs and scope pins survive leaving Skills; switching projects restores the correct draft and requires a fresh preview.');

  await area('Library');await choose('review-checkout');await readerArea('Details');
  for(const [setting,expected] of [['off',0],['auto',0],['full',1]]){await page.evaluate(value=>document.documentElement.dataset.motion=value,setting);await readerArea('SKILL.md');await readerArea('Details');const duration=await page.locator('.skills-reader-content').evaluate(el=>parseFloat(getComputedStyle(el).animationDuration));assert.equal(duration>0?1:0,expected);}
  await page.evaluate(()=>document.documentElement.dataset.motion='off');const win=await app.browserWindow(page);await win.evaluate(w=>w.setSize(1024,900));await capture('library-narrow');
  for(const name of ['Library','Write','Sources']){await area(name);const size=await page.evaluate(()=>({width:innerWidth,page:document.documentElement.scrollWidth,panel:document.querySelector('.skills-scroll').clientWidth,scroll:document.querySelector('.skills-scroll').scrollWidth}));dimensions.push({name,...size});assert(size.page<=size.width);assert(size.scroll<=size.panel+1);if(name!=='Library')await capture(name.toLowerCase()+'-narrow');}
  await win.evaluate(w=>w.setSize(1440,1000));await area('Library');await page.evaluate(()=>window.__skillRows=[]);await page.getByRole('button',{name:'Rescan disk'}).click();await waitText('.skills-directory','No Claude Code skills found');await capture('empty');
  record('Motion respects Off, Auto and Full; all three areas fit a narrow desktop and an empty scan offers a clear next action.');

 }
 assert.deepEqual(errors,[]);writeFileSync(path.join(out,'verification.json'),JSON.stringify({checks,errors,dimensions},null,2)+'\n');console.log('Skills captures complete.');
}finally{await app.close();rmSync(dir,{recursive:true,force:true});}
