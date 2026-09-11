#!/usr/bin/env node
// Actual renderer, isolated Electron, synthetic files and recording services.
import { STUB, rendererURL } from './renderer-harness.mjs';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
const require = createRequire(import.meta.url), { _electron } = require('playwright-core');
const root=path.resolve(import.meta.dirname,'..'), before=process.argv.includes('--before');
const out=path.join(root,'docs/visuals/context-workspace',before?'before':'after');
mkdirSync(out,{recursive:true});
const dir=mkdtempSync(path.join(tmpdir(),'wanigan-context-'));
writeFileSync(path.join(dir,'main.cjs'),`const {app,BrowserWindow}=require('electron');app.whenReady().then(()=>new BrowserWindow({width:1440,height:1000,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}).loadURL('about:blank'));`);
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
for(const key of Object.keys(env))if(key.startsWith('VSCODE_'))delete env[key];
const app=await _electron.launch({executablePath:path.join(root,'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron'),args:[path.join(dir,'main.cjs'),`--user-data-dir=${dir}/profile`],env});
const checks=[],errors=[],dimensions=[];
const record=text=>{checks.push(text);console.log(text);};
try {
  const page=await app.firstWindow();page.setDefaultTimeout(15000);
  // A verified older package can supply the before renderer after the source
  // build has moved on. No installed app is launched or modified.
  const archiveAt=process.argv.indexOf('--archive');
  if(archiveAt>=0){
    const archive=process.argv[archiveAt+1],asar=require('@electron/asar');
    await page.route(rendererURL.replace('/index.html','/**'),route=>{
      const name='out/renderer'+new URL(route.request().url()).pathname;
      const mime={'.html':'text/html','.js':'text/javascript','.css':'text/css','.png':'image/png','.svg':'image/svg+xml'}[path.extname(name)]??'application/octet-stream';
      return route.fulfill({body:asar.extractFile(archive,name),contentType:mime});
    });
  }
  page.on('pageerror',e=>errors.push(e.message));
  await page.emulateMedia({reducedMotion:'reduce'});
  await page.addInitScript(STUB);
  await page.addInitScript(()=>{
    const original=window.wanigan,now=Date.now();
    window.__contextCalls=[];window.__contextReads=[];
    const fixture=root=>{
      const file=(name,scope,order,extra={})=>({path:root+'/'+name,scope,exists:true,bytes:720,lines:18,order,depth:0,importedBy:null,external:false,conditional:null,duplicate:false,warnings:[],excludedBy:null,...extra});
      const files=[
        file('CLAUDE.md','project',1),
        file('AGENTS.md','import',2,{depth:1,importedBy:root+'/CLAUDE.md',bytes:3400,lines:74}),
        file('.claude/rules/testing.md','rule',3,{conditional:{kind:'paths',globs:['src/**/*.test.ts'],matchingFiles:12}}),
        file('.claude/rules/legacy.md','rule',4,{conditional:{kind:'paths',globs:['legacy/**'],matchingFiles:0},warnings:['No project files match this rule.']}),
        file('.claude/CLAUDE.md','project',5,{duplicate:true}),
        file('docs/missing.md','import',6,{exists:false,bytes:0,lines:0,depth:1,importedBy:root+'/CLAUDE.md',warnings:['Referenced file is missing.']}),
      ];
      const mem=(name,isIndex,extra={})=>({name,path:root+'/.memory/'+name,kind:'project',description:isIndex?'The index used at launch.':'Keep retries safe without duplicating a payment.',bytes:isIndex?21000:1600,lines:isIndex?220:36,modified:now-7200000,modifiedFrontmatter:null,links:[],isIndex,...extra});
      const index=mem('MEMORY.md',true),topics=[mem('checkout-retries.md',false),mem('design-system.md',false,{kind:'reference',description:'Shared interface materials and interaction patterns.'})];
      return {
        chain:{files,totalBytes:4120,totalLines:92,atLaunch:files.slice(0,2),onDemand:[files[2],files[3]],notes:['Imports are shown in the order the scanner resolved them.'],root,isGitRepo:true},
        memory:{dir:root+'/.memory',exists:true,enabled:true,derivedFrom:'git-repo',index,indexBudget:{lines:220,lineLimit:200,bytes:21000,byteLimit:25600,loadedLines:200,droppedLines:20,overBudget:true,note:'The first 200 lines load. The remaining 20 lines are outside the index budget.'},files:[index,...topics],counts:{user:0,feedback:0,project:2,reference:1,unknown:0},danglingLinks:[],orphans:[],notes:[]},
        config:{settings:[{key:'model',value:'claude-sonnet-5',from:'project',shadowed:[{from:'user',value:'claude-opus-5'}]},{key:'permissions.defaultMode',value:'default',from:'user',shadowed:[]}],layers:[{layer:'user',path:'/example/home/.claude/settings.json',exists:true,keys:2},{layer:'project',path:root+'/.claude/settings.json',exists:true,keys:3},{layer:'local',path:root+'/.claude/settings.local.json',exists:false,keys:0},{layer:'managed',path:'/example/policy/managed-settings.json',exists:false,keys:0}],hooks:[{event:'PostToolUse',matcher:'Edit',type:'command',summary:'npm run format:changed',from:'project',source:root+'/.claude/settings.json'}],mcp:[{name:'project-docs',transport:'stdio',target:'docs-server',from:'project',source:root+'/.mcp.json'}],agents:[],commands:[],permissions:[{allow:['Read(*)'],ask:['Bash(npm test)'],deny:['Read(.env)'],from:'project'}],notes:[]},
        agents:{present:true,imported:true,symlinked:false,note:'AGENTS.md is imported by CLAUDE.md.'},
        codex:{files:[{path:root+'/AGENTS.md',scope:'project',exists:true,bytes:3400,managed:true}],note:'These are compiler targets, not a prediction of Codex load order.'},
        budget:{files:files.slice(0,2).map(f=>({path:f.path,label:f.scope+' · '+f.path.split('/').at(-1),bytes:f.bytes,estTokens:Math.round(f.bytes/4)})),totalBytes:4120,skippedBytes:0,estTokens:1030,usdPerSession:0.00309,model:'claude-sonnet-5',note:'A byte-based estimate of the instruction files, before a session starts.'},
      };
    };
    window.wanigan=new Proxy(original,{get(api,service){
      if(service==='context')return new Proxy(api.context,{get(context,method){
        if(method==='read'||method==='memoryBody')return async p=>{
          window.__contextReads.push([method,p]);
          if(window.__fileFailure===p)throw new Error('Fixture file unavailable');
          const text='# '+p.split('/').at(-1)+'\n\n'+(p.includes('/platform/')?'Platform source.':'Storefront source.')+'\n\nKeep the existing trust boundaries.\nUse focused tests for changes.\n\n'+Array.from({length:50},(_,i)=>'Document line '+(i+1)+': '+(i===3?'<script>fixture text, never executed</script>':'Review evidence before reporting completion.')).join('\n');
          const body={text,bytes:text.length,truncated:!!window.__truncateFile};
          if(window.__holdFile===p)return new Promise(resolve=>window.__releaseFile=()=>resolve(body));
          return body;
        };
        if(method==='refresh')return async p=>{window.__contextCalls.push(['refresh',p]);};
        return async(...args)=>{
          const root=method==='codexAgents'?args[1]:args[0];
          window.__contextReads.push([method,...args]);
          if(window.__scanFailure===root||window.__channelFailure===method)throw new Error('Fixture scan unavailable');
          const f=fixture(root);
          if(window.__emptyContext){f.chain={...f.chain,files:[],atLaunch:[],onDemand:[],totalBytes:0,totalLines:0};f.memory={...f.memory,exists:false,index:null,indexBudget:null,files:[]};f.agents={present:false,imported:false,symlinked:false,note:'No AGENTS.md was found.'};f.config={settings:[],layers:[],hooks:[],mcp:[],agents:[],commands:[],permissions:[],notes:[]};}
          const value=({instructions:f.chain,memory:f.memory,config:f.config,agentsMd:f.agents,codexAgents:f.codex,budget:f.budget})[method];
          if(method==='instructions'&&window.__removeSource){
            for(const key of ['files','atLaunch','onDemand'])value[key]=value[key].filter(file=>file.path!==window.__removeSource);
            value.totalBytes=value.atLaunch.reduce((sum,file)=>sum+file.bytes,0);value.totalLines=value.atLaunch.reduce((sum,file)=>sum+file.lines,0);
          }
          if(window.__holdScan===root&&method==='instructions')return new Promise(resolve=>window.__releaseScan=()=>resolve(value));
          return value;
        };
      }});
      if(service==='learning')return new Proxy(api.learning,{get(learning,method){
        if(method==='projections')return async()=>[{targetPath:'/example/storefront/AGENTS.md'}];
        if(method==='settings')return async()=>({enabled:!window.__emptyContext,briefingMaxTokens:4000});
        if(method==='overview')return async()=>({activeKnowledge:window.__emptyContext?0:14,quarantined:0,pending:0,signals:0,activeSkills:0});
        return learning[method];
      }});
      if(service==='sessions')return new Proxy(api.sessions,{get(sessions,method){if(method==='list')return async()=> (await sessions.list()).map(s=>({...s,harnessId:s.providerId==='claude'?'claude-code':'codex'}));return sessions[method];}});
      if(service==='skills')return new Proxy(api.skills,{get(skills,method){if(method==='send')return async(...args)=>window.__contextCalls.push(['send',...args]);return skills[method];}});
      return api[service];
    }});
  });
  await page.goto(rendererURL);await page.waitForSelector('.mission-room');
  const go=async chord=>{await page.locator('.space-dock button').first().focus();await page.keyboard.press(chord);};
  await page.getByRole('button',{name:'Projects',exact:true}).click();
  await page.getByRole('button',{name:'Context',exact:true}).click();
  await page.getByRole('heading',{name:'Context',exact:true}).waitFor();
  await page.getByRole('button',{name:'Re-scan',exact:true}).waitFor();
  await page.waitForFunction(()=>document.querySelector('.ctx .stat-grid'));
  await page.waitForFunction(()=>Number(document.querySelector('.companion-presence canvas')?.dataset.frames)>0);
  for(const theme of ['dark','light']){
    await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
    await page.screenshot({path:path.join(out,`instructions-${theme}.png`),scale:'css'});
  }
  if(before){
    for(const [key,title] of [['rules','Rules'],['agents','AGENTS.md'],['memory','Memory'],['config','Settings and hooks'],['budget','Startup budget'],['learning','Learning briefing']]){
      await page.locator(`.section[data-section-title="${title}"]`).evaluate(el=>el.scrollIntoView({block:'start'}));
      for(const theme of ['dark','light']){
        await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        await page.screenshot({path:path.join(out,`${key}-${theme}.png`),scale:'css'});
      }
    }
  } else {
    const areas=[['chain','Instructions'],['rules','Rules'],['agents','AGENTS.md'],['memory','Memory'],['config','Settings & hooks'],['budget','Startup budget'],['learning','Learning briefing']];
    const tabs=page.getByRole('tablist',{name:'Context sections'});
    const picker=page.getByRole('combobox',{name:'Context project'});
    const region=page.locator('.ctx-area:visible');
    const reader=page.getByRole('complementary',{name:'Source file reader'});
    const source=path=>region.getByRole('button',{name:'Read '+path,exact:true});
    const select=async label=>{await tabs.getByRole('tab',{name:label,exact:true}).click();};
    const ready=async()=>page.getByRole('button',{name:'Re-scan',exact:true}).waitFor();
    const scan=async()=>{await page.getByRole('button',{name:'Re-scan',exact:true}).click();await ready();};
    const close=async()=>{await reader.getByRole('button',{name:'Close source reader'}).click();await reader.waitFor({state:'hidden'});};
    assert.equal(await page.locator('.ctx-area').count(),7);
    assert.equal(await region.count(),1);
    assert.equal((await page.evaluate(()=>window.__contextReads.filter(row=>['read','memoryBody'].includes(row[0])))).length,0);
    for(const [key,label] of areas){
      await select(label);
      assert.equal(await region.getAttribute('id'),'ctx-area-'+key);
      for(const theme of ['dark','light']){
        await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        await page.screenshot({path:path.join(out,`${key==='chain'?'instructions':key}-${theme}.png`),scale:'css'});
      }
    }
    record('all seven areas stay mounted with one visible; section navigation reads no source file or agent session');

    await tabs.getByRole('tab',{name:'Learning briefing',exact:true}).focus();
    await page.keyboard.press('Home');assert.equal(await region.getAttribute('id'),'ctx-area-chain');
    await page.keyboard.press('ArrowDown');assert.equal(await region.getAttribute('id'),'ctx-area-rules');
    await page.keyboard.press('End');assert.equal(await region.getAttribute('id'),'ctx-area-learning');
    await select('Instructions');
    await source('/example/platform/CLAUDE.md').click();
    await reader.getByText('Source file · Read only',{exact:true}).waitFor();
    await reader.locator('pre').waitFor();
    assert.equal(await page.evaluate(()=>document.activeElement?.tagName),'H2');
    assert.match(await reader.locator('pre').innerText(),/<script>fixture text, never executed<\/script>/);
    assert.equal(await reader.locator('script,input,textarea,[contenteditable=true]').count(),0);
    assert.equal(await region.count(),1);
    for(const theme of ['dark','light']){
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      await page.screenshot({path:path.join(out,`source-${theme}.png`),scale:'css'});
    }
    await reader.getByRole('button',{name:'Wrap lines',exact:true}).click();
    assert.equal(await reader.locator('pre').evaluate(el=>getComputedStyle(el).whiteSpace),'pre');
    await reader.getByRole('button',{name:'Wrap lines',exact:true}).click();
    await page.keyboard.press('Escape');await reader.waitFor({state:'hidden'});
    assert(await source('/example/platform/CLAUDE.md').evaluate(el=>el===document.activeElement));
    record('keyboard section navigation works; opening a source focuses its reader, preserves report visibility, escapes raw markup, and restores the opener');

    await page.evaluate(()=>window.__holdFile='/example/platform/CLAUDE.md');
    await source('/example/platform/CLAUDE.md').click();
    await page.waitForFunction(()=>typeof window.__releaseFile==='function');
    await source('/example/platform/AGENTS.md').click();
    await reader.locator('pre').waitFor();
    assert.match(await reader.locator('pre').innerText(),/^# AGENTS.md/);
    await page.evaluate(()=>{window.__holdFile=null;window.__releaseFile();});
    assert.match(await reader.locator('pre').innerText(),/^# AGENTS.md/);
    await close();
    await page.evaluate(()=>window.__fileFailure='/example/platform/AGENTS.md');
    await source('/example/platform/AGENTS.md').click();
    await reader.getByText(/Fixture file unavailable/).waitFor();
    assert.equal(await reader.locator('pre').count(),0);
    await page.evaluate(()=>{window.__fileFailure=null;window.__truncateFile=true;});
    await reader.getByRole('button',{name:'Try reading again',exact:true}).click();
    await reader.getByText(/Truncated for display/).waitFor();await reader.locator('pre').waitFor();
    await close();await page.evaluate(()=>window.__truncateFile=false);
    assert.equal(await source('/example/platform/docs/missing.md').isDisabled(),true);
    record('late source responses cannot replace the selected file; failures expose retry, truncation is explicit, and missing files cannot be opened');

    const search=page.getByRole('searchbox',{name:'Filter instruction files by path'});
    await search.fill('testing');
    await region.getByRole('group',{name:'Instruction load states'}).getByRole('button',{name:/^on demand/}).click();
    assert.equal(await region.locator('.ctx-file-list > li').count(),1);
    await select('Memory');await select('Instructions');assert.equal(await search.inputValue(),'testing');
    await go('Meta+2');await page.getByRole('heading',{name:'Fleet',exact:true}).waitFor();
    await go('Meta+Shift+C');await ready();assert.equal(await search.inputValue(),'testing');
    assert.equal(await region.locator('.ctx-file-list > li').count(),1);
    await search.fill('no-match');await region.getByRole('heading',{name:'No instruction files match.',exact:true}).waitFor();
    await region.getByRole('button',{name:'Clear the filter',exact:true}).click();
    assert.equal(await region.locator('.ctx-file-list > li').count(),6);
    record('instruction query and load-state filters survive sections and route changes; empty search can return to the complete ordered chain');

    await select('Memory');
    assert.match(await region.innerText(),/200 lines load/);assert.match(await region.innerText(),/20 lines dropped/);
    const meter=await region.locator('.ctx-index-meter').evaluate(el=>({width:el.getBoundingClientRect().width,track:el.querySelector('rect').getBoundingClientRect().width}));
    assert(Math.abs(meter.width-meter.track)<1,'the index meter must use the full available track');
    await source('/example/platform/.memory/MEMORY.md').click();await reader.locator('pre').waitFor();
    assert.deepEqual(await page.evaluate(()=>window.__contextReads.filter(row=>row[0]==='memoryBody').at(-1)),['memoryBody','/example/platform/.memory/MEMORY.md']);
    await close();
    await source('/example/platform/.memory/checkout-retries.md').click();await reader.locator('pre').waitFor();await close();
    await select('Settings & hooks');await region.locator('.ctx-disclosure').first().locator('summary').click();
    for(const text of ['Read(*)','Bash(npm test)','Read(.env)'])assert(await region.getByText(text,{exact:true}).isVisible());
    await select('Startup budget');assert.match(await region.innerText(),/~1,030\s*est/);
    await select('Learning briefing');assert.match(await region.innerText(),/4,000/);assert.doesNotMatch(await region.innerText(),/~4,000/);
    record('memory index and topics use the memory reader; reported line cuts stay distinct from byte limits, permission rules are inspectable, and estimates stay labeled');

    await page.evaluate(()=>window.__holdScan='/example/storefront');
    await picker.selectOption('p1');await page.waitForFunction(()=>typeof window.__releaseScan==='function');
    assert.equal(await page.locator('.ctx-workspace').count(),0);
    await picker.selectOption('p2');await ready();
    await page.evaluate(()=>{window.__holdScan=null;window.__releaseScan();});
    assert.equal(await picker.inputValue(),'p2');
    await select('Instructions');assert.equal(await region.getByRole('button',{name:'Read /example/storefront/CLAUDE.md',exact:true}).count(),0);
    await page.evaluate(()=>window.__scanFailure='/example/storefront');
    await picker.selectOption('p1');await ready();
    await page.getByText('Wanigan could not read anything about storefront.',{exact:true}).waitFor();
    assert.equal(await page.locator('.ctx-workspace').count(),0);
    await page.evaluate(()=>window.__scanFailure=null);await scan();
    await source('/example/storefront/CLAUDE.md').waitFor();
    record('switching projects removes the previous report immediately; late scans and failed switches cannot show old files under the new project');

    await source('/example/storefront/CLAUDE.md').click();await reader.locator('pre').waitFor();
    await page.evaluate(()=>window.__removeSource='/example/storefront/CLAUDE.md');await scan();
    await reader.getByRole('heading',{name:'This file is no longer in the scan.',exact:true}).waitFor();
    assert.equal(await reader.locator('pre').count(),0);await close();
    await page.evaluate(()=>{window.__removeSource=null;window.__channelFailure='memory';});await scan();
    await select('Memory');await region.getByText(/Fixture scan unavailable/).waitFor();
    assert.equal(await region.getByRole('button',{name:/^Read /}).count(),0);
    await select('Instructions');assert.equal(await region.locator('.ctx-file-list > li').count(),6);
    await page.evaluate(()=>window.__channelFailure=null);await scan();
    record('a rescan replaces open source contents and removes missing sources; one failed channel leaves other reports usable without invented empty counts');

    await page.evaluate(()=>document.documentElement.dataset.motion='full');
    await source('/example/storefront/CLAUDE.md').click();await reader.locator('pre').waitFor();
    assert.notEqual(await reader.evaluate(el=>getComputedStyle(el).animationDuration),'0s');await close();
    await page.evaluate(()=>document.documentElement.dataset.motion='off');
    await source('/example/storefront/CLAUDE.md').click();await reader.locator('pre').waitFor();
    assert.equal(await reader.evaluate(el=>getComputedStyle(el).animationDuration),'0s');await close();
    await page.evaluate(()=>document.documentElement.dataset.motion='auto');
    await source('/example/storefront/CLAUDE.md').click();await reader.locator('pre').waitFor();
    assert.equal(await reader.evaluate(el=>getComputedStyle(el).animationDuration),'0s');await close();
    record('reader motion honors Off and system Reduce Motion while retaining the explicit Full override');

    await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(820,960));
    await page.waitForFunction(()=>window.innerWidth===820);
    for(const [key,label] of areas){
      await select(label);
      const size=await page.locator('.ctx-view').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));
      assert(size.scroll<=size.width+1);dimensions.push({area:key,...size});
      for(const theme of ['dark','light']){
        await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
        await page.screenshot({path:path.join(out,`${key}-narrow-${theme}.png`),scale:'css'});
      }
    }
    await select('Instructions');await source('/example/storefront/CLAUDE.md').click();await reader.locator('pre').waitFor();
    assert.equal(await region.count(),0);assert((await reader.boundingBox()).width<820);
    for(const theme of ['dark','light']){
      await page.evaluate(t=>document.documentElement.dataset.theme=t,theme);
      await page.screenshot({path:path.join(out,`source-narrow-${theme}.png`),scale:'css'});
    }
    await close();assert.equal(await region.count(),1);
    record('all seven areas fit a narrow desktop; the source reader occupies the working area and closing it restores the report');

    assert.deepEqual(await page.evaluate(()=>window.__contextCalls.filter(row=>row[0]==='send')),[]);
    await page.evaluate(()=>window.__emptyContext=true);await scan();
    await region.getByRole('button',{name:'Type /init into a session',exact:true}).click();
    await region.getByText(/Typed \/init into the running session in storefront/).waitFor();
    assert.deepEqual(await page.evaluate(()=>window.__contextCalls.filter(row=>row[0]==='send')),[['send','s1','/init']]);
    await picker.selectOption('p2');await ready();
    await region.getByRole('button',{name:'Type /init into a session',exact:true}).click();
    await region.getByText(/No Claude Code session is running in platform/).waitFor();
    assert.equal((await page.evaluate(()=>window.__contextCalls.filter(row=>row[0]==='send'))).length,1);
    record('empty Instructions retains an explicit /init action that types only into a running Claude Code session; a Codex-only project cannot receive it');
  }
  assert.deepEqual(errors,[]);
  writeFileSync(path.join(out,'verification.json'),JSON.stringify({at:new Date().toISOString(),provenance:'Actual Electron renderer, synthetic files and services, no real agent calls',checks,dimensions,errors},null,2)+'\n');
} finally {await app.close();rmSync(dir,{recursive:true,force:true});}
