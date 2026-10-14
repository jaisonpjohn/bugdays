import { ShareManager } from './share.ts';
import { track, sizeBucket, countBucket } from './analytics.ts';
import { YAML_LIMITS, defaultYamlOptions, validateYamlSize } from './yaml-diff-shared.ts';
import type { YamlOptions, YamlResult, YamlValue } from './yaml-diff-shared.ts';
import { yamlExampleLeft, yamlExampleRight, yamlExampleOptions } from './yaml-diff-examples.ts';

function init() {
  const root=document.getElementById('yaml-workspace'); if(!root || root.dataset.init) return; root.dataset.init='true';
  const life=new AbortController(), signal=life.signal;
  const el=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
  const inputs=[el<HTMLTextAreaElement>('yaml1'),el<HTMLTextAreaElement>('yaml2')];
  const docs=el<HTMLSelectElement>('document-mode'), arrays=el<HTMLSelectElement>('array-mode'), key=el<HTMLInputElement>('array-key'), ignored=el<HTMLTextAreaElement>('ignored-paths'), generated=el<HTMLInputElement>('ignore-generated'), auto=el<HTMLInputElement>('auto-compare');
  let result:YamlResult|null=null, worker:Worker|null=null, version=0, active=0, pageStart=0, visible:number[]=[], busy=false, tracked=false;
  let delay:ReturnType<typeof setTimeout>|undefined, timeout:ReturnType<typeof setTimeout>|undefined, errorLocation:{side:number|null;offset:number|null}|null=null;
  let fileEpoch=0; const fileTokens=[0,0], lineCounts=[1,1];
  const status=(text:string)=>{el('yaml-status').textContent=text;};
  const options=():YamlOptions=>({documents:docs.value as YamlOptions['documents'],arrays:arrays.value as YamlOptions['arrays'],arrayKey:key.value,ignoredPaths:ignored.value,ignoreGenerated:generated.checked});
  function controls() {
    for(const id of ['copy-report','download-json','download-txt']) el<HTMLButtonElement>(id).disabled=!result||busy;
    el<HTMLButtonElement>('cancel-btn').hidden=!busy; root!.setAttribute('aria-busy',String(busy));
    key.disabled=arrays.value!=='key';
  }
  function stop(){version++;clearTimeout(delay);clearTimeout(timeout);worker?.terminate();worker=null;busy=false;controls();}
  function reset(){result=null;active=0;pageStart=0;el('results').hidden=true;el('changes-list').replaceChildren();el('stats').hidden=true;controls();}
  function gutter(side:number,refresh=false) {
    const input=inputs[side], box=input.closest('[data-yaml-editor]')!.querySelector<HTMLElement>('[data-yaml-gutter]')!;
    if(refresh){lineCounts[side]=input.value.split('\n').length;el('yaml'+(side+1)+'-count').textContent=lineCounts[side].toLocaleString()+' lines · '+new TextEncoder().encode(input.value).length.toLocaleString()+' bytes';}
    const total=lineCounts[side], height=Number.parseFloat(getComputedStyle(input).lineHeight)||21, first=Math.max(0,Math.floor((input.scrollTop-12)/height));
    const span=document.createElement('span'); span.style.display='block';span.style.transform=`translateY(${first*height-input.scrollTop}px)`;
    span.textContent=Array.from({length:Math.max(0,Math.min(total-first,Math.ceil(input.clientHeight/height)+2))},(_,i)=>String(first+i+1)).join('\n');box.replaceChildren(span);
  }
  function focus(side:number,offset:number,length=1) {
    const input=inputs[side], pos=Math.max(0,Math.min(offset,input.value.length));input.focus();input.setSelectionRange(pos,Math.min(input.value.length,pos+length));
    const height=Number.parseFloat(getComputedStyle(input).lineHeight)||21;
    input.scrollTop=Math.max(0,(input.value.slice(0,pos).split('\n').length-1)*height-input.clientHeight/2);
    const column=pos-input.value.lastIndexOf('\n',pos-1)-1;input.scrollLeft=Math.max(0,column*8-input.clientWidth/2);gutter(side);
  }
  function showError(message:string,side:number|null=null,offset:number|null=null) {
    stop();reset();el('error-box').hidden=false;el('error-text').textContent=(side===null?'':(side===0?'Original: ':'Modified: '))+message;
    errorLocation={side,offset};el('error-jump').hidden=side===null||offset===null;status('Check the highlighted input and compare again.');
  }
  const selected=()=>result?.changes[active];
  function inspect() {
    const change=selected();el('selected-change').hidden=!change||!visible.includes(active);if(!change)return;
    el('selected-path').textContent=change.path;
    for(const [side,value] of [[0,change.original],[1,change.modified]] as const) {
      const prefix=side===0?'old':'new';el(prefix+'-value').textContent=value ? value.yaml.slice(0,10000)+(value.yaml.length>10000?'\n… Preview limited; Copy includes the whole value.':'') : 'Not present';
      el(prefix+'-location').textContent=value ? `Document ${value.document} · line ${value.line}, column ${value.column}` : '—';
      for(const action of ['copy','jump']) el<HTMLButtonElement>(prefix+'-'+action).disabled=!value;
    }
  }
  function render() {
    if(!result)return;
    const filter=el<HTMLSelectElement>('change-filter').value, query=el<HTMLInputElement>('change-search').value.toLowerCase();
    visible=result.changes.flatMap((change,i)=>(filter==='all'||change.type===filter)&&(!query||[change.path,change.original?.yaml??'',change.modified?.yaml??''].some(text=>text.toLowerCase().includes(query)))?[i]:[]);
    pageStart=Math.min(pageStart,Math.max(0,Math.floor((visible.length-1)/50)*50));
    if(visible.length&&!visible.includes(active))active=visible[pageStart];
    const fragment=document.createDocumentFragment();
    for(const index of visible.slice(pageStart,pageStart+50)) {
      const change=result.changes[index], button=document.createElement('button');button.type='button';button.className='yaml-change yaml-'+change.type;button.dataset.changeIndex=String(index);button.setAttribute('aria-pressed',String(index===active));
      const badge=document.createElement('span');badge.className='yaml-badge';badge.textContent=change.type;
      const path=document.createElement('code');path.textContent=change.path;button.append(badge,path);
      button.addEventListener('click',()=>{active=index;render();},{signal});fragment.append(button);
    }
    el('changes-list').replaceChildren(fragment);el('results').hidden=false;
    el('change-count').textContent=visible.length ? `${pageStart+1}–${Math.min(pageStart+50,visible.length)} of ${visible.length.toLocaleString()} shown` : result.changes.length ? 'No changes match the filter.' : 'No semantic differences under the selected rules.';
    el<HTMLButtonElement>('previous-page').disabled=pageStart===0;el<HTMLButtonElement>('next-page').disabled=pageStart+50>=visible.length;
    el('stats').hidden=false;el('stats').textContent=`${result.changes.length.toLocaleString()} ${result.changes.length===1?'change':'changes'} · ${result.changes.filter(c=>c.type==='added').length} added · ${result.changes.filter(c=>c.type==='removed').length} removed · ${result.changes.filter(c=>c.type==='modified').length} modified · ${result.documents[0]} original / ${result.documents[1]} modified documents${result.ignored ? ' · '+result.ignored+' ignored fields/entries across both inputs' : ''}${arrays.value==='key' ? ' · '+result.keyedLists+' keyed lists across both inputs; others positional' : ''}`;
    inspect();controls();
  }
  async function run(mode:'compare'|'format'='compare',user=false) {
    stop();reset();el('error-box').hidden=true;errorLocation=null;busy=true;controls();status(mode==='format'?'Formatting locally…':'Comparing locally…');
    const id=version;
    try {
      for(const [side,input] of inputs.entries()) try{validateYamlSize(input.value);}catch(error){showError((error as Error).message,side);return;}
      const module=await import('./yaml-diff.worker.ts?worker');if(signal.aborted||id!==version)return;worker=new module.default();
      worker.onerror=()=>{if(id===version&&!signal.aborted)showError('The local worker could not finish. Try a smaller file or reload the page.');};
      worker.onmessage=event=>{
        if(signal.aborted||id!==version)return;clearTimeout(timeout);worker?.terminate();worker=null;busy=false;
        if(event.data.error){const error=event.data.error;showError(error.message,error.side,error.offset);return;}
        if(mode==='format') {inputs.forEach((input,side)=>{input.value=event.data.formatted[side];gutter(side,true);});findMatches();status('Both inputs formatted locally. Values, comments and anchors preserved. Compare to inspect changes.');track('tool_used',{tool:'yaml-diff',action:'format'});controls();if(auto.checked)delay=setTimeout(()=>run('compare',false),300);return;}
        result=event.data.result;ShareManager.setLastAction('compare');render();status('Comparison ready. Select a change to inspect values and source lines, or share both inputs and settings.');
        if(user&&!tracked){tracked=true;track('tool_used',{tool:'yaml-diff',action:'compare',count:countBucket(result!.changes.length),size:sizeBucket(new TextEncoder().encode(inputs[0].value+inputs[1].value).length)});}
      };
      timeout=setTimeout(()=>showError('Comparison timed out. Try fewer documents or a smaller file.'),30000);
      worker.postMessage({id,mode,left:inputs[0].value,right:inputs[1].value,options:options()});
    } catch(error){if(!signal.aborted&&id===version)showError(error instanceof Error?error.message:'Unable to start local processing.');}
  }
  function changed(){stop();reset();el('error-box').hidden=true;errorLocation=null;controls();inputs.forEach((_,side)=>gutter(side,true));findMatches();status('Inputs or rules changed. Compare YAML to refresh the result.');if(auto.checked&&inputs.every(input=>input.value.trim()))delay=setTimeout(()=>run('compare',true),300);}
  inputs.forEach((input,side)=>{
    input.addEventListener('input',()=>{fileTokens[side]++;changed();},{signal});input.addEventListener('scroll',()=>gutter(side),{signal});
    input.addEventListener('paste',event=>{
      const text=event.clipboardData?.getData('text/plain');if(!text||(text.length<50000&&text.split('\n',502).length<500))return;event.preventDefault();
      const value=input.value.slice(0,input.selectionStart)+text+input.value.slice(input.selectionEnd);
      try{validateYamlSize(value);input.setRangeText(text,input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input',{bubbles:true}));}catch(error){showError((error as Error).message,side);}
    },{signal});
    input.addEventListener('keydown',event=>{if(event.key==='Tab'&&!event.shiftKey){event.preventDefault();input.setRangeText('  ',input.selectionStart,input.selectionEnd,'end');input.dispatchEvent(new Event('input',{bubbles:true}));}},{signal});
    const picker=el<HTMLInputElement>('yaml'+(side+1)+'-file');el('yaml'+(side+1)+'-open').addEventListener('click',()=>picker.click(),{signal});
    async function load(file:File) {
      const token=++fileTokens[side],epoch=fileEpoch;
      try{if(file.size>YAML_LIMITS.bytes)throw new Error('Choose a file no larger than 5 MiB.');const text=new TextDecoder('utf-8',{fatal:true}).decode(await file.arrayBuffer());if(signal.aborted||token!==fileTokens[side]||epoch!==fileEpoch)return;validateYamlSize(text);input.value=text;changed();track('import_used',{tool:'yaml-diff',format:'yaml',size:sizeBucket(file.size)});}
      catch(error){if(!signal.aborted&&token===fileTokens[side]&&epoch===fileEpoch)showError(error instanceof TypeError?'Open a valid UTF-8 YAML file.':(error as Error).message,side);}
    }
    picker.addEventListener('change',()=>{const file=picker.files?.[0];picker.value='';if(file)load(file);},{signal});
    const shell=input.closest<HTMLElement>('[data-yaml-editor]')!;
    shell.addEventListener('dragover',event=>{event.preventDefault();shell.classList.add('yaml-drop');},{signal});shell.addEventListener('dragleave',()=>shell.classList.remove('yaml-drop'),{signal});
    shell.addEventListener('drop',event=>{event.preventDefault();shell.classList.remove('yaml-drop');if(event.dataTransfer?.files[0])load(event.dataTransfer.files[0]);},{signal});gutter(side,true);
  });
  for(const node of [docs,arrays,key,ignored,generated,auto])node.addEventListener(node===key||node===ignored?'input':'change',changed,{signal});
  el('compare-btn').addEventListener('click',()=>run(),{signal});el('format-btn').addEventListener('click',()=>run('format'),{signal});
  el('cancel-btn').addEventListener('click',()=>{stop();reset();status('Cancelled. Your original inputs are unchanged.');},{signal});
  el('clear-btn').addEventListener('click',()=>{fileEpoch++;inputs.forEach(input=>input.value='');changed();},{signal});
  el('swap-btn').addEventListener('click',()=>{fileEpoch++;[inputs[0].value,inputs[1].value]=[inputs[1].value,inputs[0].value];changed();},{signal});
  el('sample-btn').addEventListener('click',()=>{fileEpoch++;inputs[0].value=yamlExampleLeft;inputs[1].value=yamlExampleRight;docs.value=yamlExampleOptions.documents;arrays.value=yamlExampleOptions.arrays;key.value=yamlExampleOptions.arrayKey;generated.checked=true;ignored.value='';changed();run('compare',true);},{signal});
  for(const id of ['change-filter','change-search'])el(id).addEventListener(id==='change-search'?'input':'change',()=>{pageStart=0;render();},{signal});
  el('previous-page').addEventListener('click',()=>{pageStart-=50;active=visible[pageStart]??0;render();},{signal});el('next-page').addEventListener('click',()=>{pageStart+=50;active=visible[pageStart]??0;render();},{signal});
  async function copy(text:string,action:string){try{await navigator.clipboard.writeText(text);status('Copied '+action.replaceAll('-',' ')+'.');track('copy_used',{tool:'yaml-diff',action});}catch{status('Clipboard unavailable. Download the JSON or TXT report instead.');}}
  el('copy-report').addEventListener('click',()=>{if(result)copy(result.textReport,'report');},{signal});
  el('copy-path').addEventListener('click',()=>{const change=selected();if(change)copy((change.modified??change.original)!.pointer,'pointer');},{signal});
  for(const [side,prefix] of [[0,'old'],[1,'new']] as const){
    const value=():YamlValue|undefined=>side===0?selected()?.original:selected()?.modified;
    el(prefix+'-copy').addEventListener('click',()=>{const item=value();if(item)copy(item.yaml,side===0?'original-value':'modified-value');},{signal});
    el(prefix+'-jump').addEventListener('click',()=>{const item=value();if(item)focus(side,item.offset);},{signal});
  }
  for(const format of ['json','txt'] as const)el('download-'+format).addEventListener('click',()=>{
    if(!result||busy)return;const url=URL.createObjectURL(new Blob([format==='json'?result.report:result.textReport],{type:format==='json'?'application/json':'text/plain;charset=utf-8'}));
    const link=document.createElement('a');link.href=url;link.download='yaml-diff-report.'+format;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);track('export_used',{tool:'yaml-diff',format});
  },{signal});
  el('share-comparison').addEventListener('click',()=>{ShareManager.setLastAction('compare');el('share-btn')?.click();},{signal});
  el('error-jump').addEventListener('click',()=>{if(errorLocation?.side!==null&&errorLocation?.offset!==null&&errorLocation)focus(errorLocation.side,errorLocation.offset);},{signal});
  const find=el<HTMLInputElement>('find-query'),scope=el<HTMLSelectElement>('find-side');let matches:number[]=[],findIndex=-1;
  function findMatches(){const text=inputs[Number(scope.value)].value,query=find.value;matches=[];if(query){const pattern=new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g,'\\$&'),'giu');for(const match of text.matchAll(pattern)){matches.push(match.index!);if(matches.length===500)break;}}findIndex=-1;el('find-count').textContent=matches.length+(matches.length===500?'+':'')+' matches';}
  find.addEventListener('input',findMatches,{signal});scope.addEventListener('change',findMatches,{signal});
  for(const [id,step] of [['find-next',1],['find-previous',-1]] as const)el(id).addEventListener('click',()=>{if(!matches.length)return;findIndex=findIndex<0?(step<0?matches.length-1:0):(findIndex+step+matches.length)%matches.length;focus(Number(scope.value),matches[findIndex],find.value.length);el('find-count').textContent=(findIndex+1)+' / '+matches.length+(matches.length===500?'+':'');},{signal});
  window.addEventListener('resize',()=>inputs.forEach((_,side)=>gutter(side)),{signal});
  ShareManager.register({tool:'yaml-diff',actions:{compare:()=>{if(!signal.aborted&&el('error-box').hidden)run();}},customCollect:()=>({yaml1:inputs[0].value,yaml2:inputs[1].value,...options(),autoCompare:auto.checked}),customRestore:data=>{
    fileEpoch++;stop();reset();el('error-box').hidden=true;inputs.forEach(input=>input.value='');
    docs.value=data.documents==='kubernetes'?'kubernetes':'position';arrays.value=['position','unordered','key'].includes(data.arrays)?data.arrays:'position';key.value=typeof data.arrayKey==='string'?data.arrayKey:defaultYamlOptions.arrayKey;ignored.value=typeof data.ignoredPaths==='string'?data.ignoredPaths:'';generated.checked=data.ignoreGenerated===true;auto.checked=data.autoCompare===true;
    const values=[typeof data.yaml1==='string'?data.yaml1:'',typeof data.yaml2==='string'?data.yaml2:''];try{values.forEach(validateYamlSize);}catch(error){showError((error as Error).message);return;}
    inputs.forEach((input,side)=>{input.value=values[side];gutter(side,true);});el<HTMLDetailsElement>('yaml-advanced').open=arrays.value!=='position'||!!ignored.value;
    el<HTMLSelectElement>('change-filter').value='all';el<HTMLInputElement>('change-search').value='';find.value='';findMatches();controls();run();
  }});
  controls();document.addEventListener('astro:before-swap',()=>{fileEpoch++;stop();life.abort();},{once:true});
}
init();document.addEventListener('astro:after-swap',init);
