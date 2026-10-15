import { LanguageSwitch } from './LanguageSwitch';
import { msg, useLocale } from '../lib/i18n';
import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useApi } from '../api/context';
import type { AgentId, GlobalConfig, McpDef, ProjectSummary } from '../api/types';
import { ALL_AGENTS } from '../api/types';
import { useConfig } from '../api/queries';
import { AGENT_LABEL, tildify } from '../lib/format';
import { DirectoryInput } from './DirectoryInput';
import { SimpleDialog } from './Dialog';
import { ErrorBox, LevelGlyph } from './ui';
import { useToast } from './Toaster';

export function useSubmit<T>(fn: () => Promise<T>, onDone: (v: T) => void) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const qc = useQueryClient();
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const v = await fn();
      await qc.invalidateQueries();
      onDone(v);
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, submit };
}

export function RelocateDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  useLocale();
  const api = useApi();
  const [picking, setPicking] = useState(false);
  const toast = useToast();
  const [path, setPath] = useState(tildify(project.path));
  const { busy, error, submit } = useSubmit(
    () => api.patchProject(project.id, { path }),
    () => {
      toast.push({ tone: 'ok', title: msg("已重新定位 {0}", {0: project.name}), detail: path });
      onClose();
    },
  );
  return (
    <SimpleDialog
      open
      onClose={() => { if (!busy && !picking) onClose(); }}
      cap={msg("{0} · 目录不存在", {0: project.name})}
      title={msg("重新定位…")}
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" disabled={busy || picking} onClick={onClose}>
            {msg("取消")}</button>
          <button type="submit" form="relocate-form" className="btn btn-p btn-lg" disabled={busy || picking || !path.trim()}>
            {msg("重新定位")}</button>
        </>
      }
    >
      <form id="relocate-form" className="flex flex-col gap-1.5" onSubmit={(e) => { if (picking || busy) e.preventDefault(); else void submit(e); }}>
        <label htmlFor="relocate-path" className="label">
          {msg("新的项目目录")}</label>
        <DirectoryInput id="relocate-path" autoFocus value={path} onChange={setPath} placeholder="~/work/old-landing" disabled={busy || picking} onPickingChange={setPicking} />
        <span className="text-[12px] leading-[1.6] text-ink3">{msg("原路径：")}<code className="mono">{tildify(project.path)}</code>{msg("。只更新注册表，不移动任何文件。")}</span>
      </form>
      {error != null && <ErrorBox error={error} />}
    </SimpleDialog>
  );
}

export function UnregisterDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  useLocale();
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const { busy, error, submit } = useSubmit(
    () => api.unregisterProject(project.id),
    () => {
      toast.push({ tone: 'ok', title: msg("已从注册表移除 {0}", {0: project.name}) });
      onClose();
      navigate('/');
    },
  );
  return (
    <SimpleDialog
      open
      onClose={onClose}
      cap={project.name}
      title={msg("从注册表移除？")}
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
            {msg("取消")}</button>
          <button type="button" className="btn btn-d btn-lg" disabled={busy} onClick={() => void submit()}>
            {msg("从注册表移除")}</button>
        </>
      }
    >
      <p className="m-0 text-[14px] leading-[1.6] text-ink2">
        {msg("atm 不再跟踪")}<code className="mono">{tildify(project.path)}</code>{msg("。不会删除任何文件；之后在该目录执行任意 atm 写操作会重新注册。")}</p>
      {error != null && <ErrorBox error={error} />}
    </SimpleDialog>
  );
}

export function RegisterProjectDialog({ onClose }: { onClose: () => void }) {
  useLocale();
  const api = useApi();
  const [picking, setPicking] = useState(false);
  const navigate = useNavigate();
  const [path, setPath] = useState('');
  const { busy, error, submit } = useSubmit(
    async () => {
      const project = await api.registerProject(path);
      if (!project.initialized) await api.initProject(project.id);
      return project;
    },
    (p) => {
      onClose();
      navigate(`/projects/${p.id}`);
    },
  );
  return (
    <SimpleDialog
      open
      onClose={() => { if (!busy && !picking) onClose(); }}
      cap={msg("项目")}
      title={msg("注册项目")}
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" disabled={busy || picking} onClick={onClose}>
            {msg("取消")}</button>
          <button type="submit" form="register-form" className="btn btn-p btn-lg" disabled={busy || picking || !path.trim()}>
            {msg("注册")}</button>
        </>
      }
    >
      <form id="register-form" className="flex flex-col gap-1.5" onSubmit={(e) => { if (picking || busy) e.preventDefault(); else void submit(e); }}>
        <label htmlFor="register-path" className="label">
          {msg("项目目录")}</label>
        <DirectoryInput id="register-path" autoFocus value={path} onChange={setPath} placeholder="~/work/my-app" disabled={busy || picking} onPickingChange={setPicking} />
        <span className="text-[12px] leading-[1.6] text-ink3">{msg("添加目录并初始化项目工具清单与 Agent 入口。已有工具不会自动加入；发生文件冲突时会保留原文件并提示。")}</span>
      </form>
      {error != null && <ErrorBox error={error} />}
    </SimpleDialog>
  );
}

export function CloneRepoDialog({ onClose }: { onClose: () => void }) {
  useLocale();
  const api = useApi();
  const [repo, setRepo] = useState('');
  const { busy, error, submit } = useSubmit(() => api.cloneRepo(repo), () => onClose());
  return (
    <SimpleDialog
      open
      onClose={onClose}
      cap={msg("工具库")}
      title={msg("克隆仓库…")}
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
            {msg("取消")}</button>
          <button type="submit" form="clone-form" className="btn btn-p btn-lg" disabled={busy || !repo.trim()}>
            {msg("克隆")}</button>
        </>
      }
    >
      <form id="clone-form" className="flex flex-col gap-1.5" onSubmit={(e) => void submit(e)}>
        <label htmlFor="clone-repo" className="label">
          {msg("仓库")}</label>
        <input id="clone-repo" data-autofocus className="input input-lg mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder={msg("owner/repo 或 git URL")} />
        <span className="text-[12px] leading-[1.6] text-ink3">{msg("克隆到共享根目录下；完成后其中的 SKILL.md 会出现在工具库。克隆在后台进行，可以随时取消。")}</span>
      </form>
      {error != null && <ErrorBox error={error} />}
    </SimpleDialog>
  );
}

type KV = Array<{ k: string; v: string }>;

export function NewMcpDialog({ onClose }: { onClose: () => void }) {
  useLocale();
  const api = useApi();
  const toast = useToast();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [transport, setTransport] = useState<'stdio' | 'http'>('stdio');
  const [command, setCommand] = useState('npx');
  const [args, setArgs] = useState('');
  const [url, setUrl] = useState('');
  const [vars, setVars] = useState<KV>([{ k: '', v: '' }]);
  const [confirmCmd, setConfirmCmd] = useState(false);

  const kv = Object.fromEntries(vars.filter((x) => x.k.trim()).map((x) => [x.k.trim(), x.v.trim()]));
  const def: McpDef =
    transport === 'stdio'
      ? {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          transport,
          command: command.trim(),
          ...(args.trim() ? { args: args.trim().split(/\s+/) } : {}),
          ...(Object.keys(kv).length ? { env: kv } : {}),
        }
      : {
          name: name.trim(),
          ...(description.trim() ? { description: description.trim() } : {}),
          transport,
          url: url.trim(),
          ...(Object.keys(kv).length ? { headers: kv } : {}),
        };
  const { busy, error, submit } = useSubmit(
    () => api.createSharedTool({ kind: 'mcp', def }),
    (r) => {
      toast.push({ tone: 'ok', title: msg("已保存 MCP 定义 {0}", {0: def.name}), detail: tildify(r.path) });
      onClose();
    },
  );
  const valid = !!name.trim() && (transport === 'stdio' ? !!command.trim() && confirmCmd : !!url.trim());

  return (
    <SimpleDialog
      open
      onClose={onClose}
      cap={msg("工具库 · registry")}
      title={msg("新建 MCP 定义…")}
      maxWidth={640}
      footer={
        <>
          <span className="mono mr-auto text-[12px] text-ink3">{name.trim() ? `mcp-registry/${name.trim()}.json` : ''}</span>
          <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
            {msg("取消")}</button>
          <button type="submit" form="mcp-form" className="btn btn-p btn-lg" disabled={busy || !valid}>
            {msg("保存定义")}</button>
        </>
      }
    >
      <form id="mcp-form" className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="label">{msg("名称")}</span>
            <input data-autofocus className="input mono" value={name} onChange={(e) => setName(e.target.value)} placeholder="linear" />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="label">transport</span>
            <div role="tablist" aria-label="transport" className="glass flex gap-1 self-start rounded-full p-1">
              {(['stdio', 'http'] as const).map((t) => (
                <button key={t} type="button" role="tab" className="seg mono" aria-selected={transport === t} onClick={() => setTransport(t)}>
                  {t}
                </button>
              ))}
            </div>
          </div>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="label">{msg("描述（可选）")}</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder={msg("一句话说明它做什么")} />
        </label>
        {transport === 'stdio' ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
            <label className="flex flex-col gap-1.5">
              <span className="label">command</span>
              <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label">{msg("args（空格分隔）")}</span>
              <input className="input mono" value={args} onChange={(e) => setArgs(e.target.value)} placeholder="-y @linear/mcp" />
            </label>
          </div>
        ) : (
          <label className="flex flex-col gap-1.5">
            <span className="label">url</span>
            <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://mcp.linear.app/mcp" />
          </label>
        )}
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="label pb-1.5">{transport === 'stdio' ? 'env' : 'headers'} {msg("· 值必须写成 $")}{'{VAR}'} {msg("引用")}</legend>
          {vars.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
              <input
                className="input mono"
                aria-label={msg("变量名")}
                value={row.k}
                placeholder={transport === 'stdio' ? 'LINEAR_TOKEN' : 'Authorization'}
                onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
              />
              <input
                className="input mono"
                aria-label={msg("值")}
                value={row.v}
                placeholder={transport === 'stdio' ? '${LINEAR_TOKEN}' : 'Bearer ${LINEAR_TOKEN}'}
                onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
              />
              <button type="button" className="btn btn-t" aria-label={msg("删除这一行")} onClick={() => setVars(vars.length > 1 ? vars.filter((_, j) => j !== i) : [{ k: '', v: '' }])}>
                −
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-t btn-sm self-start" onClick={() => setVars([...vars, { k: '', v: '' }])}>
            {msg("+ 添加一行")}</button>
        </fieldset>
        {transport === 'stdio' && (
          <label className="flex items-start gap-2.5 rounded-[12px] px-3.5 py-3 text-[13px] leading-[1.6]" style={{ background: 'var(--warn-soft)' }}>
            <input type="checkbox" className="mt-1" checked={confirmCmd} onChange={(e) => setConfirmCmd(e.target.checked)} />
            <span>
              <LevelGlyph level="warn" size={8} className="mr-2 align-middle" />
              {msg("我确认")}<code className="mono">{[command, args].filter(Boolean).join(' ') || '…'}</code> {msg("会在本机执行任意命令，来源可信。")}</span>
          </label>
        )}
      </form>
      {error != null && <ErrorBox error={error} />}
    </SimpleDialog>
  );
}

/** `atm pin <skill> <rev>`: ask for the revision, then hand over to the dryRun diff flow. */
export function PinDialog({ project, skill, current, onSubmit, onClose }: { project: ProjectSummary; skill: string; current?: string; onSubmit: (rev: string) => void; onClose: () => void }) {
  useLocale();
  const [rev, setRev] = useState(current ?? '');
  const ok = rev.trim().length > 0;
  const go = (e?: FormEvent) => {
    e?.preventDefault();
    if (ok) onSubmit(rev.trim());
  };
  return (
    <SimpleDialog
      open
      onClose={onClose}
      cap={msg("{0} · 固定版本", {0: project.name})}
      title={<span className="mono">{skill}</span>}
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
            {msg("取消")}</button>
          <button type="submit" form="pin-form" className="btn btn-p btn-lg" disabled={!ok}>
            {msg("下一步：预览 diff")}</button>
        </>
      }
    >
      <form id="pin-form" className="flex flex-col gap-1.5" onSubmit={go}>
        <label htmlFor="pin-rev" className="label">
          {msg("版本（tag / 分支 / commit）")}</label>
        <input id="pin-rev" data-autofocus className="input input-lg mono" value={rev} onChange={(e) => setRev(e.target.value)} placeholder="v1.2.0" spellCheck={false} />
        <span className="text-[12px] leading-[1.6] text-ink3">
          {msg("等价于")}<code className="mono">atm pin {skill} &lt;rev&gt;</code>{msg("：为该版本建一个独立的 git worktree，项目里的软链改为指向它，之后共享仓库升级不会影响这个项目。")}</span>
      </form>
    </SimpleDialog>
  );
}

/** Global settings (`~/.config/atm`): shared repo root, MCP registry directory, default agents for new projects. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  useLocale();
  const api = useApi();
  const [picking, setPicking] = useState(false);
  const toast = useToast();
  const { data: cfg, error: loadError } = useConfig();
  const [root, setRoot] = useState<string | null>(null);
  const [registry, setRegistry] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentId[] | null>(null);
  const curRoot = root ?? (cfg ? tildify(cfg.root) : '');
  const curRegistry = registry ?? (cfg ? tildify(cfg.mcpRegistry) : '');
  const curAgents = agents ?? cfg?.defaultAgents ?? [];
  const dirty =
    !!cfg && (curRoot !== tildify(cfg.root) || curRegistry !== tildify(cfg.mcpRegistry) || curAgents.length !== cfg.defaultAgents.length || curAgents.some((a) => !cfg.defaultAgents.includes(a)));
  const { busy, error, submit } = useSubmit(
    () =>
      api.initSharedRepository({
        root: curRoot.trim(),
        mcpRegistry: curRegistry.trim(),
        defaultAgents: curAgents,
      }),
    () => {
      toast.push({ tone: 'ok', title: msg("仓库已更新") });
      onClose();
    },
  );
  const toggle = (a: AgentId) => {
    const on = curAgents.includes(a);
    if (on && curAgents.length === 1) return;
    setAgents(on ? curAgents.filter((x) => x !== a) : ALL_AGENTS.filter((x) => x === a || curAgents.includes(x)));
  };
  return (
    <SimpleDialog
      open
      onClose={() => { if (!busy && !picking) onClose(); }}
      cap={msg("全局")}
      title={msg("更新仓库")}
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" disabled={busy || picking} onClick={onClose}>
            {msg("取消")}</button>
          <button type="submit" form="settings-form" className="btn btn-p btn-lg" disabled={busy || picking || !dirty || !validDirectory(curRoot) || !validDirectory(curRegistry)}>
            {busy ? msg("更新中…") : msg("更新仓库")}
          </button>
        </>
      }
    >
      <LanguageSwitch />
      <form id="settings-form" className="flex flex-col gap-4" onSubmit={(e) => { if (picking || busy || !dirty || !validDirectory(curRoot) || !validDirectory(curRegistry)) e.preventDefault(); else void submit(e); }}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cfg-root" className="label">
            {msg("共享仓库目录")}</label>
          <DirectoryInput id="cfg-root" value={curRoot} onChange={(value) => {
            if (curRegistry.replace(/\/+$/, '') === defaultRegistry(curRoot)) setRegistry(defaultRegistry(value));
            setRoot(value);
          }} placeholder="~/.agent-tools" disabled={!cfg || busy || picking} onPickingChange={setPicking} />
          <span className="text-[12px] leading-[1.6] text-ink3">{msg("更新共享仓库路径；缺失目录会自动创建并准备好 Git 仓库。已有文件不会搬迁，项目软链不会自动更改。")}</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cfg-registry" className="label">
            {msg("MCP registry 目录")}</label>
          <DirectoryInput id="cfg-registry" value={curRegistry} onChange={setRegistry} placeholder="~/.agent-tools/mcp-registry" disabled={!cfg || busy || picking} onPickingChange={setPicking} />
        </div>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="label pb-1.5">{msg("新项目默认落地的 Agent")}</legend>
          <div className="flex flex-wrap gap-2">
            {ALL_AGENTS.map((a) => (
              <label key={a} className={`agt ${curAgents.includes(a) ? '' : 'off'}`}>
                <input type="checkbox" checked={curAgents.includes(a)} onChange={() => toggle(a)} disabled={!cfg || busy || picking} />
                {AGENT_LABEL[a]}
              </label>
            ))}
          </div>
        </fieldset>
      </form>
      {(error ?? loadError) != null && <ErrorBox error={error ?? loadError} />}
    </SimpleDialog>
  );
}

const defaultRegistry = (root: string) => root.trim() ? `${root.trim().replace(/\/+$/, '')}/mcp-registry` : '';
const validDirectory = (value: string) => /^(\/|~(?:\/|$))/.test(value.trim()) && !value.includes('\0');

export function InitSharedDirectoryDialog({ onClose, onInitialized }: {
  onClose: () => void;
  onInitialized?: (cfg: GlobalConfig) => void;
}) {
  useLocale();
  const api = useApi();
  const [picking, setPicking] = useState(false);
  const toast = useToast();
  const { data: cfg, error: loadError } = useConfig();
  const [root, setRoot] = useState<string | null>(null);
  const [registry, setRegistry] = useState<string | null>(null);
  const curRoot = root ?? (cfg ? tildify(cfg.root) : '');
  const curRegistry = registry ?? (cfg ? tildify(cfg.mcpRegistry) : '');
  const valid = validDirectory(curRoot) && validDirectory(curRegistry);
  const { busy, error, submit } = useSubmit(
    () => api.initSharedRepository({ root: curRoot.trim(), mcpRegistry: curRegistry.trim() }),
    (next) => {
      toast.push({ tone: 'ok', title: msg("共享目录已就绪"), detail: `${next.root} · MCP registry：${next.mcpRegistry}` });
      onInitialized?.(next);
      onClose();
    },
  );
  const close = () => { if (!busy && !picking) onClose(); };
  return (
    <SimpleDialog open onClose={close} cap={msg("全局")} title={msg("初始化共享目录")} footer={<>
      <button type="button" className="btn btn-t btn-lg" disabled={busy || picking} onClick={close}>{msg("取消")}</button>
      <button type="submit" form="init-shared-directory-form" className="btn btn-p btn-lg" disabled={busy || picking || !cfg || !valid}>
        {busy ? msg("创建中…") : msg("创建并保存")}
      </button>
    </>}>
      <form id="init-shared-directory-form" className="flex flex-col gap-4" onSubmit={(e) => {
        if (busy || picking || !cfg || !valid) { e.preventDefault(); return; }
        void submit(e);
      }}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="init-shared-root" className="label">{msg("共享根目录")}</label>
          <DirectoryInput id="init-shared-root" placeholder="~/.agent-tools" value={curRoot} disabled={busy || picking || !cfg} onPickingChange={setPicking} onChange={(value) => {
            if (curRegistry.replace(/\/+$/, '') === defaultRegistry(curRoot)) setRegistry(defaultRegistry(value));
            setRoot(value);
          }} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="init-shared-registry" className="label">{msg("MCP registry 目录")}</label>
          <DirectoryInput id="init-shared-registry" placeholder="~/.agent-tools/mcp-registry" value={curRegistry} disabled={busy || picking || !cfg} onPickingChange={setPicking} onChange={setRegistry} />
        </div>
        <p className="m-0 text-[12px] leading-[1.6] text-ink3">{msg("请输入绝对路径或 ~/ 开头的路径。缺失的目录会自动创建，同时初始化本地 Git 仓库；已有内容会保留。更换路径不会搬迁已有仓库或重建项目软链。")}</p>
      </form>
      {(error ?? loadError) != null && <ErrorBox error={error ?? loadError} />}
    </SimpleDialog>
  );
}
