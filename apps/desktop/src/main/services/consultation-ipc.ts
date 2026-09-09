import type { IpcMain } from 'electron';
import { z } from 'zod';
import { ConsultationInputSchema } from '@app/domain';
import { ipcChannels } from '../../shared/ipc.js';
import type { ConsultationService } from './consultation-service.js';
export function registerConsultationIpc(ipc:IpcMain,service:ConsultationService){
  ipc.handle(ipcChannels.consultationAsk,(_event,input:unknown)=>service.ask(ConsultationInputSchema.parse(input)));
  ipc.handle(ipcChannels.consultationCancel,(_event,id:unknown)=>service.cancel(z.string().uuid().parse(id)));
  ipc.handle(ipcChannels.consultationSave,(_event,id:unknown)=>service.save(z.string().uuid().parse(id)));
}
