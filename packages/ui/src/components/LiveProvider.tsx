import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/context';
import type { ConnectionStatus } from '../api/client';
import type { ActivityEntry, AtmEvent } from '../api/types';
import { qk } from '../api/queries';
import { useToast } from './Toaster';

const StatusCtx = createContext<ConnectionStatus>('connecting');
export const useConnection = () => useContext(StatusCtx);

/** Subscribes to SSE once and keeps the TanStack cache in sync. */
export function LiveProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const qc = useQueryClient();
  const toast = useToast();
  const [status, setStatus] = useState<ConnectionStatus>('connecting');

  useEffect(() => {
    const titles = new Map<string, string>();
    const onEvent = (e: AtmEvent) => {
      switch (e.type) {
        case 'project.changed':
          void qc.invalidateQueries({ queryKey: qk.projects });
          void qc.invalidateQueries({ queryKey: qk.project(e.projectId) });
          void qc.invalidateQueries({ queryKey: qk.generated(e.projectId) });
          void qc.invalidateQueries({ queryKey: qk.doctorAll });
          void qc.invalidateQueries({ queryKey: qk.library });
          void qc.invalidateQueries({ queryKey: qk.global });
          break;
        case 'library.changed':
          void qc.invalidateQueries({ queryKey: qk.library });
          void qc.invalidateQueries({ queryKey: qk.repos });
          void qc.invalidateQueries({ queryKey: qk.global });
          void qc.invalidateQueries({ queryKey: qk.doctorAll });
          break;
        case 'activity':
          qc.setQueryData<ActivityEntry[]>(qk.activity, (old) => [e.entry, ...(old ?? [])].slice(0, 50));
          break;
        case 'task.started':
          titles.set(e.taskId, e.title);
          toast.push({
            id: e.taskId,
            title: e.title,
            tone: 'running',
            detail: '已开始',
            onCancel: () => void api.cancelTask(e.taskId),
          });
          break;
        case 'task.progress':
          toast.update(e.taskId, { detail: e.message, ...(e.percent !== undefined ? { percent: e.percent } : {}) });
          break;
        case 'task.done':
          toast.update(e.taskId, { tone: 'ok', detail: '已完成' });
          void qc.invalidateQueries();
          break;
        case 'task.failed':
          toast.update(e.taskId, { tone: 'err', detail: e.error });
          break;
        case 'task.cancelled':
          toast.update(e.taskId, { tone: 'info', detail: '已取消' });
          break;
      }
    };
    return api.subscribe(onEvent, setStatus);
  }, [api, qc, toast]);

  return <StatusCtx.Provider value={status}>{children}</StatusCtx.Provider>;
}
