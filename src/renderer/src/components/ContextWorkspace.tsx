import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Chip, EmptyState, Icon, Note, Reading, type IconName } from './bits';
import { useRememberedScrollRef, useViewMemory } from './viewMemory';

export const CONTEXT_AREAS = [
  {key:'chain',label:'Instructions',detail:'The launch order',icon:'file-text'},
  {key:'rules',label:'Rules',detail:'Matched to your files',icon:'branch'},
  {key:'agents',label:'AGENTS.md',detail:'Across harnesses',icon:'book'},
  {key:'memory',label:'Memory',detail:'Index and topic files',icon:'brain'},
  {key:'config',label:'Settings & hooks',detail:'Layers and commands',icon:'sliders'},
  {key:'budget',label:'Startup budget',detail:'Estimated input cost',icon:'gauge'},
  {key:'learning',label:'Learning briefing',detail:'Approved knowledge',icon:'layers'},
] as const satisfies readonly {key:string;label:string;detail:string;icon:IconName}[];
export type ContextArea = typeof CONTEXT_AREAS[number]['key'];
type Source = {path:string;kind:'instruction'|'memory'};
type SourceAccess = {file:Source|null;open:(source:Source,opener:HTMLElement)=>void};
const SourceContext = createContext<SourceAccess|null>(null);

/** Opening a listed source is a read, never an editor or a launch action. */
export function ContextFileLink({path,kind='instruction',disabled=false,children}: {
  path:string;kind?:Source['kind'];disabled?:boolean;children:ReactNode;
}) {
  const reader = useContext(SourceContext);
  return <button type="button" className="ctx-open" disabled={disabled}
    aria-label={`Read ${path}`} aria-pressed={reader?.file?.path===path}
    onClick={event=>reader?.open({path,kind},event.currentTarget)}>
    <Icon name="file-text" /> <span className="ctx-file-label">{children}</span><Icon name="chevron-right" />
  </button>;
}

export default function ContextWorkspace({projectId,panels,hints,counts,issues,scan,knownSources,guide}: {
  projectId:string;panels:Record<ContextArea,ReactNode>;hints:Record<ContextArea,string>;
  counts:Partial<Record<ContextArea,number>>;issues:Partial<Record<ContextArea,boolean>>;
  scan:number;knownSources:string[];guide:ReactNode;
}) {
  const [area,setArea] = useViewMemory<ContextArea>(`${projectId}/area`,'chain');
  const [file,setFile] = useViewMemory<Source|null>(`${projectId}/source`,null);
  const opener = useRef<HTMLElement|null>(null);
  const close = () => {
    setFile(null);
    requestAnimationFrame(()=>{
      const target = opener.current?.isConnected ? opener.current : document.getElementById(`ctx-tab-${area}`);
      target?.focus();
    });
  };
  const pick = (key:ContextArea) => {setFile(null);setArea(key);};
  return <SourceContext.Provider value={{file,open:(source,element)=>{opener.current=element;setFile(source);}}}>
    <div className={`ctx-workspace${file?' with-source':''}`}>
      <nav className="ctx-directory" aria-label="Context areas">
        <div role="tablist" aria-label="Context sections" className="ctx-tabs">
          {CONTEXT_AREAS.map((item,index)=><button key={item.key} type="button" role="tab" id={`ctx-tab-${item.key}`}
            aria-label={item.label} aria-controls={`ctx-area-${item.key}`} aria-selected={area===item.key}
            aria-description={issues[item.key]?'Needs attention':counts[item.key]!==undefined?`${counts[item.key]} entries`:item.detail}
            tabIndex={area===item.key?0:-1} onClick={()=>pick(item.key)} onKeyDown={event=>{
              const offset = ['ArrowDown','ArrowRight'].includes(event.key)?1:['ArrowUp','ArrowLeft'].includes(event.key)?-1:0;
              const next = event.key==='Home'?0:event.key==='End'?CONTEXT_AREAS.length-1:offset?(index+offset+CONTEXT_AREAS.length)%CONTEXT_AREAS.length:null;
              if(next===null)return;event.preventDefault();
              const target=CONTEXT_AREAS[next].key;pick(target);document.getElementById(`ctx-tab-${target}`)?.focus();
            }}>
            <Icon name={item.icon}/><span><strong>{item.label}</strong><small>{item.detail}</small></span>
            {issues[item.key]?<span className="ctx-directory-issue" aria-label="Needs attention">!</span>
              :counts[item.key]!==undefined&&<span className="ctx-directory-count">{counts[item.key]}</span>}
          </button>)}
        </div>
        <div className="ctx-directory-guide">{guide}</div>
      </nav>
      <div className="ctx-panels">
        {CONTEXT_AREAS.map(item=><Area key={item.key} area={item.key} projectId={projectId} active={area===item.key}
          title={item.label} hint={hints[item.key]}>{panels[item.key]}</Area>)}
      </div>
      {file&&<SourceReader key={`${file.kind}:${file.path}:${scan}`} source={file} onClose={close}
        known={knownSources.includes(file.path)}/>}
    </div>
  </SourceContext.Provider>;
}

function Area({area,projectId,active,title,hint,children}: {
  area:ContextArea;projectId:string;active:boolean;title:string;hint:string;children:ReactNode;
}) {
  const scroll = useRememberedScrollRef(`${projectId}/${area}`);
  return <section className="ctx-area" ref={scroll} id={`ctx-area-${area}`} role="tabpanel"
    aria-labelledby={`ctx-tab-${area}`} hidden={!active} tabIndex={0}>
    <div className="ctx-area-intro"><h2>{title}</h2><p>{hint}</p></div>
    {children}
  </section>;
}

function SourceReader({source,known,onClose}: {source:Source;known:boolean;onClose:()=>void}) {
  const [body,setBody]=useState<{text:string;bytes:number;truncated:boolean}|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [attempt,setAttempt]=useState(0);
  const [wrap,setWrap]=useViewMemory('source-wrap',true);
  const title=useRef<HTMLHeadingElement>(null);
  useEffect(()=>{title.current?.focus();},[]);
  useEffect(()=>{
    if(!known)return;
    let live=true;setBody(null);setError(null);
    const read=source.kind==='memory'?window.wanigan.context.memoryBody:window.wanigan.context.read;
    void read(source.path).then(result=>{if(live)setBody(result);}).catch(cause=>{
      if(live)setError(cause instanceof Error?cause.message:String(cause));
    });
    return()=>{live=false;};
  },[source.path,source.kind,known,attempt]);
  return <aside id="ctx-source-reader" className="ctx-source" aria-label="Source file reader"
    onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();onClose();}}}>
    <div className="ctx-source-toolbar"><span>Source file · Read only</span>
      <button className="btn btn-sm" type="button" aria-label="Close source reader" onClick={onClose}><Icon name="x"/></button></div>
    <div className="ctx-source-identity"><h2 tabIndex={-1} ref={title}>{source.path.split(/[\\/]/).at(-1)}</h2>
      <p>{source.path}</p>
      <div className="ctx-source-options"><Chip pressed={wrap} onToggle={()=>setWrap(!wrap)}>Wrap lines</Chip>
        {body&&<span>{new Intl.NumberFormat().format(body.bytes)} bytes</span>}</div>
    </div>
    {!known?<EmptyState posture="nothing-in-scope" title="This file is no longer in the scan."
      cue="Close the reader and choose a file from the latest reading."/>
      :error?<div className="ctx-source-message"><Note tone="error"><strong>Could not read this file.</strong> {error}</Note>
        <button className="btn" type="button" onClick={()=>setAttempt(value=>value+1)}>Try reading again</button></div>
        :!body?<Reading what="the source file"/>:<>
          {body.truncated&&<div className="ctx-source-message"><Note tone="warn">Truncated for display. This preview does not contain the entire file.</Note></div>}
          <pre className={`ctx-source-text${wrap?' wrap':''}`} tabIndex={0} aria-label="Source file contents">{body.text}</pre>
        </>}
  </aside>;
}
