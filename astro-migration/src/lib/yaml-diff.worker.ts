import { compareYaml, formatYamlBoth, YamlDiffError } from './yaml-diff.ts';
import type { YamlOptions } from './yaml-diff-shared.ts';
self.onmessage = (event: MessageEvent<{id:number; left:string; right:string; options:YamlOptions; mode:'compare'|'format'}>) => {
  const {id,left,right,options,mode}=event.data;
  try {self.postMessage({id,...(mode==='format' ? {formatted:formatYamlBoth(left,right)} : {result:compareYaml(left,right,options)})});}
  catch(error) {self.postMessage({id,error:{message:error instanceof Error ? error.message : 'Unable to compare these documents.',side:error instanceof YamlDiffError ? error.side : null,offset:error instanceof YamlDiffError ? error.offset : null}});}
};
