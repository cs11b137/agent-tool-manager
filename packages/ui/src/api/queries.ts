import { useQuery } from '@tanstack/react-query';
import { useApi } from './context';
import type { LibraryOptions } from './types';

export const qk = {
  config: ['config'] as const,
  projects: ['projects'] as const,
  project: (id: string) => ['project', id] as const,
  generated: (id: string) => ['generated', id] as const,
  doctor: (id?: string) => ['doctor', id ?? 'all'] as const,
  doctorAll: ['doctor'] as const,
  library: ['library'] as const,
  repos: ['repos'] as const,
  global: ['global'] as const,
  activity: ['activity'] as const,
};

export function useProjects() {
  const api = useApi();
  return useQuery({ queryKey: qk.projects, queryFn: () => api.getProjects() });
}

export function useProject(id: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.project(id), queryFn: () => api.getProject(id), retry: false });
}

export function useDoctor(id?: string) {
  const api = useApi();
  return useQuery({ queryKey: qk.doctor(id), queryFn: () => api.getDoctor(id) });
}

export function useLibrary(opts: LibraryOptions = {}) {
  const api = useApi();
  return useQuery({ queryKey: opts.includeInstalledPlugins ? [...qk.library, 'available'] : qk.library, queryFn: () => api.getLibrary(undefined, opts) });
}

export function useRepos() {
  const api = useApi();
  return useQuery({ queryKey: qk.repos, queryFn: () => api.getRepos() });
}

export function useGlobal(enabled = true) {
  const api = useApi();
  return useQuery({ queryKey: qk.global, queryFn: () => api.getGlobal(), enabled });
}

export function useActivity() {
  const api = useApi();
  return useQuery({ queryKey: qk.activity, queryFn: () => api.getActivity() });
}

export function useConfig() {
  const api = useApi();
  return useQuery({ queryKey: qk.config, queryFn: () => api.getConfig() });
}

export function useSharedRepository() {
  const api = useApi();
  return useQuery({ queryKey: ['shared-repository'], queryFn: () => api.getSharedRepository(), retry: false });
}
