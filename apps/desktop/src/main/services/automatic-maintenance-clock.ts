/** Five-second liveness samples count long async inference/FIFO waits, not suspended timers. */
export async function withAutomaticMaintenanceClock<T>(heartbeat:(now:Date,elapsed:number,unobserved:number)=>Promise<number>,work:(signal:AbortSignal)=>Promise<T>,now:()=>number=Date.now):Promise<T>{
 let previous=now(),pending=Promise.resolve(),failure:unknown;const controller=new AbortController();
 const beat=()=>{const current=now(),elapsed=Math.max(0,current-previous);previous=current;pending=pending.then(async()=>{const remaining=await heartbeat(new Date(current),elapsed<=30000?elapsed:0,elapsed>30000?elapsed:0);if(remaining<=0)controller.abort(new Error('organization.errors.deadline'));}).catch(error=>{failure=error;controller.abort(error);});return pending;};
 await beat();const timer=setInterval(()=>void beat(),5000);timer.unref?.();
 try{const result=await work(controller.signal);await beat();if(failure)throw failure;controller.signal.throwIfAborted();return result;}finally{clearInterval(timer);await beat();}
}
