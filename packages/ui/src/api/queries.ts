import { useQuery } from '@tanstack/react-query';
import { useApi } from './context';

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

export function useLibrary() {
  const api = useApi();
  return useQuery({ queryKey: qk.library, queryFn: () => api.getLibrary() });
}

export function useRepos() {
  const api = useApi();
  return useQuery({ queryKey: qk.repos, queryFn: () => api.getRepos() });
}

export function useGlobal() {
  const api = useApi();
  return useQuery({ queryKey: qk.global, queryFn: () => api.getGlobal() });
}

export function useActivity() {
  const api = useApi();
  return useQuery({ queryKey: qk.activity, queryFn: () => api.getActivity() });
}

export function useConfig() {
  const api = useApi();
  return useQuery({ queryKey: qk.config, queryFn: () => api.getConfig() });
}
