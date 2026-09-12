import type { IpcMain } from 'electron';
import { PromptCommandSchema, PromptResponseSchema } from '@app/domain';
import { ipcChannels } from '../../shared/ipc.js';
import type { PromptService } from './prompt-service.js';
export function registerPromptIpc(ipc: IpcMain, service: PromptService) { ipc.handle(ipcChannels.promptCommand, async (_event, input: unknown) => PromptResponseSchema.parse(await service.command(PromptCommandSchema.parse(input)))); }
