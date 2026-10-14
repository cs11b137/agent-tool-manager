import { useState, type FormEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { useApi } from '../api/context';
import type { AgentId, McpDef, ProjectSummary } from '../api/types';
import { ALL_AGENTS } from '../api/types';
import { useConfig } from '../api/queries';
import { AGENT_LABEL, tildify } from '../lib/format';
import { SimpleDialog } from './Dialog';
import { ErrorBox, LevelGlyph } from './ui';
import { useToast } from './Toaster';

function useSubmit<T>(fn: () => Promise<T>, onDone: (v: T) => void) {
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
  const api = useApi();
  const toast = useToast();
  const [path, setPath] = useState(tildify(project.path));
  const { busy, error, submit } = useSubmit(
    () => api.patchProject(project.id, { path }),
    () => {
      toast.push({ tone: 'ok', title: `已重新定位 ${project.name}`, detail: path });
      onClose();
    },
  );
  return (
    <SimpleDialog
      open
      onClose={onClose}
      cap={`${project.name} · 目录不存在`}
      title="重新定位…"
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="relocate-form" className="btn btn-p btn-lg" disabled={busy || !path.trim()}>
            重新定位
          </button>
        </>
      }
    >
      <form id="relocate-form" className="flex flex-col gap-1.5" onSubmit={(e) => void submit(e)}>
        <label htmlFor="relocate-path" className="label">
          新的项目目录
        </label>
        <input id="relocate-path" data-autofocus className="input input-lg mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/work/old-landing" />
        <span className="text-[12px] leading-[1.6] text-ink3">原路径：<code className="mono">{tildify(project.path)}</code>。只更新注册表，不移动任何文件。</span>
      </form>
      {error != null && <ErrorBox error={error} />}
    </SimpleDialog>
  );
}

export function UnregisterDialog({ project, onClose }: { project: ProjectSummary; onClose: () => void }) {
  const api = useApi();
  const toast = useToast();
  const navigate = useNavigate();
  const { busy, error, submit } = useSubmit(
    () => api.unregisterProject(project.id),
    () => {
      toast.push({ tone: 'ok', title: `已从注册表移除 ${project.name}` });
      onClose();
      navigate('/');
    },
  );
  return (
    <SimpleDialog
      open
      onClose={onClose}
      cap={project.name}
      title="从注册表移除？"
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
            取消
          </button>
          <button type="button" className="btn btn-d btn-lg" disabled={busy} onClick={() => void submit()}>
            从注册表移除
          </button>
        </>
      }
    >
      <p className="m-0 text-[14px] leading-[1.6] text-ink2">
        atm 不再跟踪 <code className="mono">{tildify(project.path)}</code>。不会删除任何文件；之后在该目录执行任意 atm 写操作会重新注册。
      </p>
      {error != null && <ErrorBox error={error} />}
    </SimpleDialog>
  );
}

export function RegisterProjectDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const navigate = useNavigate();
  const [path, setPath] = useState('');
  const { busy, error, submit } = useSubmit(
    () => api.registerProject(path),
    (p) => {
      onClose();
      navigate(`/projects/${p.id}`);
    },
  );
  return (
    <SimpleDialog
      open
      onClose={onClose}
      cap="项目"
      title="注册项目"
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="register-form" className="btn btn-p btn-lg" disabled={busy || !path.trim()}>
            注册
          </button>
        </>
      }
    >
      <form id="register-form" className="flex flex-col gap-1.5" onSubmit={(e) => void submit(e)}>
        <label htmlFor="register-path" className="label">
          项目目录
        </label>
        <input id="register-path" data-autofocus className="input input-lg mono" value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/work/my-app" />
        <span className="text-[12px] leading-[1.6] text-ink3">只登记到注册表，不会执行 atm init。</span>
      </form>
      {error != null && <ErrorBox error={error} />}
    </SimpleDialog>
  );
}

export function CloneRepoDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
  const [repo, setRepo] = useState('');
  const { busy, error, submit } = useSubmit(() => api.cloneRepo(repo), () => onClose());
  return (
    <SimpleDialog
      open
      onClose={onClose}
      cap="工具库"
      title="克隆仓库…"
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="clone-form" className="btn btn-p btn-lg" disabled={busy || !repo.trim()}>
            克隆
          </button>
        </>
      }
    >
      <form id="clone-form" className="flex flex-col gap-1.5" onSubmit={(e) => void submit(e)}>
        <label htmlFor="clone-repo" className="label">
          仓库
        </label>
        <input id="clone-repo" data-autofocus className="input input-lg mono" value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/repo 或 git URL" />
        <span className="text-[12px] leading-[1.6] text-ink3">克隆到共享根目录下；完成后其中的 SKILL.md 会出现在工具库。克隆在后台进行，可以随时取消。</span>
      </form>
      {error != null && <ErrorBox error={error} />}
    </SimpleDialog>
  );
}

type KV = Array<{ k: string; v: string }>;

export function NewMcpDialog({ onClose }: { onClose: () => void }) {
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
    () => api.saveMcpDef(def, 'registry'),
    (r) => {
      toast.push({ tone: 'ok', title: `已保存 MCP 定义 ${def.name}`, detail: tildify(r.path) });
      onClose();
    },
  );
  const valid = !!name.trim() && (transport === 'stdio' ? !!command.trim() && confirmCmd : !!url.trim());

  return (
    <SimpleDialog
      open
      onClose={onClose}
      cap="工具库 · registry"
      title="新建 MCP 定义…"
      maxWidth={640}
      footer={
        <>
          <span className="mono mr-auto text-[12px] text-ink3">{name.trim() ? `mcp-registry/${name.trim()}.json` : ''}</span>
          <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="mcp-form" className="btn btn-p btn-lg" disabled={busy || !valid}>
            保存定义
          </button>
        </>
      }
    >
      <form id="mcp-form" className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="flex flex-col gap-1.5">
            <span className="label">名称</span>
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
          <span className="label">描述（可选）</span>
          <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="一句话说明它做什么" />
        </label>
        {transport === 'stdio' ? (
          <div className="grid gap-3 sm:grid-cols-[1fr_2fr]">
            <label className="flex flex-col gap-1.5">
              <span className="label">command</span>
              <input className="input mono" value={command} onChange={(e) => setCommand(e.target.value)} />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="label">args（空格分隔）</span>
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
          <legend className="label pb-1.5">{transport === 'stdio' ? 'env' : 'headers'} · 值必须写成 ${'{VAR}'} 引用</legend>
          {vars.map((row, i) => (
            <div key={i} className="grid grid-cols-[1fr_1.4fr_auto] gap-2">
              <input
                className="input mono"
                aria-label="变量名"
                value={row.k}
                placeholder={transport === 'stdio' ? 'LINEAR_TOKEN' : 'Authorization'}
                onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, k: e.target.value } : x)))}
              />
              <input
                className="input mono"
                aria-label="值"
                value={row.v}
                placeholder={transport === 'stdio' ? '${LINEAR_TOKEN}' : 'Bearer ${LINEAR_TOKEN}'}
                onChange={(e) => setVars(vars.map((x, j) => (j === i ? { ...x, v: e.target.value } : x)))}
              />
              <button type="button" className="btn btn-t" aria-label="删除这一行" onClick={() => setVars(vars.length > 1 ? vars.filter((_, j) => j !== i) : [{ k: '', v: '' }])}>
                −
              </button>
            </div>
          ))}
          <button type="button" className="btn btn-t btn-sm self-start" onClick={() => setVars([...vars, { k: '', v: '' }])}>
            + 添加一行
          </button>
        </fieldset>
        {transport === 'stdio' && (
          <label className="flex items-start gap-2.5 rounded-[12px] px-3.5 py-3 text-[13px] leading-[1.6]" style={{ background: 'var(--warn-soft)' }}>
            <input type="checkbox" className="mt-1" checked={confirmCmd} onChange={(e) => setConfirmCmd(e.target.checked)} />
            <span>
              <LevelGlyph level="warn" size={8} className="mr-2 align-middle" />
              我确认 <code className="mono">{[command, args].filter(Boolean).join(' ') || '…'}</code> 会在本机执行任意命令，来源可信。
            </span>
          </label>
        )}
      </form>
      {error != null && <ErrorBox error={error} />}
    </SimpleDialog>
  );
}

/** `atm pin <skill> <rev>`: ask for the revision, then hand over to the dryRun diff flow. */
export function PinDialog({ project, skill, current, onSubmit, onClose }: { project: ProjectSummary; skill: string; current?: string; onSubmit: (rev: string) => void; onClose: () => void }) {
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
      cap={`${project.name} · 固定版本`}
      title={<span className="mono">{skill}</span>}
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="pin-form" className="btn btn-p btn-lg" disabled={!ok}>
            下一步：预览 diff
          </button>
        </>
      }
    >
      <form id="pin-form" className="flex flex-col gap-1.5" onSubmit={go}>
        <label htmlFor="pin-rev" className="label">
          版本（tag / 分支 / commit）
        </label>
        <input id="pin-rev" data-autofocus className="input input-lg mono" value={rev} onChange={(e) => setRev(e.target.value)} placeholder="v1.2.0" spellCheck={false} />
        <span className="text-[12px] leading-[1.6] text-ink3">
          等价于 <code className="mono">atm pin {skill} &lt;rev&gt;</code>：为该版本建一个独立的 git worktree，项目里的软链改为指向它，之后共享仓库升级不会影响这个项目。
        </span>
      </form>
    </SimpleDialog>
  );
}

/** Global settings (`~/.config/atm`): shared repo root, MCP registry directory, default agents for new projects. */
export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const api = useApi();
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
      api.patchConfig({
        ...(cfg && curRoot !== tildify(cfg.root) ? { root: curRoot.trim() } : {}),
        ...(cfg && curRegistry !== tildify(cfg.mcpRegistry) ? { mcpRegistry: curRegistry.trim() } : {}),
        ...(agents ? { defaultAgents: curAgents } : {}),
      }),
    () => {
      toast.push({ tone: 'ok', title: '设置已保存' });
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
      onClose={onClose}
      cap="全局"
      title="设置"
      footer={
        <>
          <button type="button" className="btn btn-t btn-lg" onClick={onClose}>
            取消
          </button>
          <button type="submit" form="settings-form" className="btn btn-p btn-lg" disabled={busy || !dirty || !curRoot.trim() || !curRegistry.trim()}>
            保存
          </button>
        </>
      }
    >
      <form id="settings-form" className="flex flex-col gap-4" onSubmit={(e) => void submit(e)}>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cfg-root" className="label">
            共享仓库目录
          </label>
          <input id="cfg-root" className="input input-lg mono" value={curRoot} onChange={(e) => setRoot(e.target.value)} placeholder="~/GitHub" spellCheck={false} disabled={!cfg} />
          <span className="text-[12px] leading-[1.6] text-ink3">Skill 原件克隆到这里，项目里只放软链。修改后已有项目的软链不会自动迁移，需要重新 install。</span>
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor="cfg-registry" className="label">
            MCP registry 目录
          </label>
          <input id="cfg-registry" className="input input-lg mono" value={curRegistry} onChange={(e) => setRegistry(e.target.value)} placeholder="~/GitHub/mcp-registry" spellCheck={false} disabled={!cfg} />
        </div>
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0">
          <legend className="label pb-1.5">新项目默认落地的 Agent</legend>
          <div className="flex flex-wrap gap-2">
            {ALL_AGENTS.map((a) => (
              <label key={a} className={`agt ${curAgents.includes(a) ? '' : 'off'}`}>
                <input type="checkbox" checked={curAgents.includes(a)} onChange={() => toggle(a)} disabled={!cfg} />
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
