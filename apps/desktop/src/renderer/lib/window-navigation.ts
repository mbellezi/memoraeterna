export type NavigationDirection='back'|'forward';
/** One renderer authority unifies native navigation and raw mouse extra buttons. */
export function createNavigationRouter(now:()=>number=Date.now){
 const listeners:Array<{callback:(direction:NavigationDirection)=>boolean|void;priority:number;order:number}>=[];let sequence=0;
 let last:{direction:NavigationDirection;origin:'native'|'mouse';at:number}|null=null;
 return{
 subscribe(listener:(direction:NavigationDirection)=>boolean|void,priority=0){const entry={callback:listener,priority,order:sequence++};listeners.push(entry);return()=>{const index=listeners.indexOf(entry);if(index>=0)listeners.splice(index,1);};},
 dispatch(direction:NavigationDirection,origin:'native'|'mouse'){
  const at=now();if(last&&last.direction===direction&&last.origin!==origin&&at-last.at<180)return true;
  last={direction,origin,at};for(const listener of listeners.toSorted((a,b)=>b.priority-a.priority||b.order-a.order))if(listener.callback(direction)!==false)return true;return false;
 },
 mouse(button:number){return button===3?'back' as const:button===4?'forward' as const:null;}
 };
}
const router=createNavigationRouter();let count=0,unsubscribe:(()=>void)|null=null;
const mouse=(event:MouseEvent)=>{const direction=router.mouse(event.button);if(direction&&router.dispatch(direction,'mouse'))event.preventDefault();};
export function subscribeWindowNavigation(listener:(direction:NavigationDirection)=>boolean|void,priority=0){
 if(count++===0){unsubscribe=window.app.system.subscribeNavigation(direction=>{router.dispatch(direction,'native');});window.addEventListener('mouseup',mouse);}
 const remove=router.subscribe(listener,priority);return()=>{remove();if(--count===0){unsubscribe?.();unsubscribe=null;window.removeEventListener('mouseup',mouse);}};
}
