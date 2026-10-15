import {test,expect} from '@playwright/test';

const slugs=[
  'pem-vs-der-vs-cer-vs-p7b-certificate-formats',
  'compare-kubernetes-yaml-ignore-order',
  'compare-two-lists-find-missing-items',
  'epoch-iso8601-timezone-offset',
  'compare-json-arrays-by-id-ignore-fields',
  'json-large-integers-duplicate-keys',
];
test.beforeEach(async({page})=>{
  await page.route('https://**/*',route=>route.abort());
  await page.addInitScript(()=>localStorage.setItem('cookie-notice-dismissed','true'));
});
for(const slug of slugs)test(`${slug}: primary guide actions stay readable in both themes`,async({page})=>{
  await page.goto('/guides/'+slug+'/');
  const action=page.locator('.guide-body a.bg-indigo-600.text-white');
  await expect(action).toHaveCount(1);
  const href=await action.getAttribute('href');expect(href).toContain('#lz:');
  for(const dark of [false,true]){
    await page.evaluate(value=>document.documentElement.classList.toggle('dark',value),dark);
    await action.scrollIntoViewIfNeeded();
    await page.mouse.move(0,0);await action.evaluate(node=>(node as HTMLElement).blur());
    for(const state of ['normal','hover','focus']){
      if(state==='hover')await action.hover();
      if(state==='focus')await action.focus();
      const appearance=await action.evaluate(node=>{
        const style=getComputedStyle(node);
        const luminance=(color:string)=>{
          const canvas=document.createElement('canvas');canvas.width=canvas.height=1;
          const context=canvas.getContext('2d')!;context.fillStyle=color;context.fillRect(0,0,1,1);
          const [r,g,b]=context.getImageData(0,0,1,1).data;
          const linear=(value:number)=>value/255<=.04045?value/255/12.92:((value/255+.055)/1.055)**2.4;
          return .2126*linear(r)+.7152*linear(g)+.0722*linear(b);
        };
        const fg=luminance(style.color),bg=luminance(style.backgroundColor);
        return {color:style.color,decoration:style.textDecorationLine,contrast:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)};
      });
      expect(appearance.color,`${dark?'dark':'light'} ${state}`).toBe('rgb(255, 255, 255)');
      expect(appearance.contrast).toBeGreaterThanOrEqual(4.5);
      expect(appearance.decoration).not.toContain('underline');
    }
    const plain=page.locator('.guide-body a:not(.text-white)').first();
    await expect(plain).toHaveCSS('color',dark?'rgb(165, 180, 252)':'rgb(79, 70, 229)');
    await expect(plain).toHaveCSS('text-decoration-line','underline');
    await expect(page.locator('.guide-article aside a')).toHaveCSS('color','rgb(255, 255, 255)');
    expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBeTruthy();
  }
  await expect(action).toHaveAttribute('href',href!);
});
