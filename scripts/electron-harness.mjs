/** Connect Chromium before loading Wanigan's main module. Electron 44 can hang
 * its debugging handshake when this large app boots under Playwright's initial
 * Node-inspector pause. This test-only bootstrap changes no production startup.
 * User-data isolation and cleanup belong to the caller. No agent is launched. */
import {writeFileSync} from 'node:fs';
import path from 'node:path';
export async function launchWanigan(electron,{root,userData,env}){
 const bootstrap=path.join(userData,'debug-bootstrap.cjs');
 writeFileSync(bootstrap,`const {app,BrowserWindow}=require('electron');
 global.loadWanigan=()=>require(${JSON.stringify(path.join(root,'out/main/index.js'))});
 app.whenReady().then(()=>{global.bootstrapWindow=new BrowserWindow({show:false});global.bootstrapWindow.loadURL('about:blank');});`);
 const binary=process.platform==='darwin'?'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron':'node_modules/electron/dist/electron';
 const app=await electron.launch({executablePath:path.join(root,binary),args:[bootstrap,`--user-data-dir=${userData}`,'--wanigan-automation'],cwd:root,env,timeout:30_000});
 try{
  await app.firstWindow();
  const opened=app.waitForEvent('window',{timeout:30_000});
  await app.evaluate(()=>{setTimeout(()=>global.loadWanigan(),20);});
  const page=await opened;
  await app.evaluate(()=>global.bootstrapWindow.destroy());
  return {app,page};
 }catch(error){await app.close();throw error;}
}
