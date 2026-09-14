import { useState } from 'react';
import { Eraser } from 'lucide-react';
import type { Translator } from '@app/i18n';
import { Button } from './ui/button';

export function TaskHistoryCleanup({ t, onCleared }: { t: Translator; onCleared: () => Promise<void> }) {
  const [busy,setBusy]=useState(false),[saved,setSaved]=useState(false),[error,setError]=useState(false);
  async function clear(){
    setBusy(true);setSaved(false);setError(false);
    try{await window.app.jobs.clearCompletedOrFailed();await onCleared();setSaved(true);}
    catch{setError(true);}finally{setBusy(false);}
  }
  return <div className="grid justify-items-end gap-1.5"><Button disabled={busy} title={t('automation.clearHistoryHint')} onClick={()=>void clear()}><Eraser size={15}/>{t(busy?'automation.clearingHistory':'automation.clearHistory')}</Button>{saved&&<p role="status" className="max-w-sm text-right text-xs text-emerald-600">{t('automation.historyCleared')}</p>}{error&&<p role="alert" className="max-w-sm text-right text-xs text-rose-600">{t('automation.clearHistoryFailed')}</p>}</div>;
}
