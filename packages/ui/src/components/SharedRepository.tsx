import { LanguageSwitch } from './LanguageSwitch';
import { msg, useLocale } from '../lib/i18n';
import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/context';
import { useSharedRepository } from '../api/queries';
import { InitSharedDirectoryDialog, NewMcpDialog, useSubmit } from './dialogs';
import { SimpleDialog } from './Dialog';
import { Select } from './Select';
import { ErrorBox, Loading } from './ui';
import { useToast } from './Toaster';

export function RepositoryGate({ children }: { children: ReactNode }) {
  useLocale();
  const status = useSharedRepository();
  const [open, setOpen] = useState(false);
  if (status.isLoading) return <Loading />;
  if (status.error) return <main className="mx-auto max-w-xl p-10"><ErrorBox error={status.error} /><button className="btn btn-p" onClick={() => void status.refetch()}>{msg("重试连接")}</button></main>;
  if (status.data?.initialized) return children;
  return <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center gap-6 p-8">
    <LanguageSwitch />
    <span className="cap">{msg("Agent Tool Manager · 第 1 步")}</span>
    <h1 className="m-0 text-3xl font-semibold">{msg("先创建你的共享仓库")}</h1>
    <p className="m-0 leading-7 text-ink2">{msg("工具原件保存在共享仓库，项目按需关联。新安装不会添加示例工具、项目或本机插件。")}</p>
    <ol className="m-0 list-decimal space-y-3 pl-5 text-ink2">
      <li>{msg("创建共享 Git 仓库")}</li><li>{msg("新建 Skill、MCP 或插件")}</li><li>{msg("添加项目目录")}</li><li>{msg("把工具关联到项目")}</li>
    </ol>
    <code className="mono text-sm text-ink3">{status.data?.root}</code>
    <button className="btn btn-p btn-lg self-start" onClick={() => setOpen(true)}>{msg("创建共享仓库")}</button>
    <p className="m-0 text-xs text-ink3">{msg("已有目录内容与已添加工具会保留。远程地址可稍后配置。")}</p>
    {open && <InitSharedDirectoryDialog onClose={() => setOpen(false)} />}
  </main>;
}

export function CreateToolDialog({ onClose }: { onClose: () => void }) {
  useLocale();
  const api = useApi();
  const toast = useToast();
  const [kind, setKind] = useState<'skill' | 'plugin' | 'mcp'>('skill');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [content, setContent] = useState('');
  const { busy, error, submit } = useSubmit(async () => {
    if (kind === 'mcp') throw new Error(msg("请选择 MCP 定义"));
    return api.createSharedTool({ kind, name: name.trim(), description: description.trim(), content });
  }, (result) => { toast.push({ tone: 'ok', title: msg("工具已创建"), detail: result.path }); onClose(); });
  if (kind === 'mcp') return <NewMcpDialog onClose={onClose} />;
  return <SimpleDialog open onClose={() => { if (!busy) onClose(); }} title={msg("新建工具")} cap={msg("共享仓库")} maxWidth={680} footer={<>
    <button className="btn btn-t" disabled={busy} onClick={onClose}>{msg("取消")}</button>
    <button className="btn btn-p" type="submit" form="create-tool" disabled={busy || !name.trim() || !description.trim() || !content.trim()}>{busy ? msg("创建中…") : msg("创建工具")}</button>
  </>}>
    <form id="create-tool" className="flex flex-col gap-4" onSubmit={(e) => { if (busy) e.preventDefault(); else void submit(e); }}>
      <Select label={msg("工具类型")} value={kind} disabled={busy} onChange={setKind} options={[
        { value: 'skill', label: 'Skill' }, { value: 'mcp', label: 'MCP' }, { value: 'plugin', label: msg("插件（Claude Code）") },
      ]} />
      <label className="flex flex-col gap-1.5">{msg("名称")}<input className="input mono" placeholder="my-tool" value={name} disabled={busy} onChange={(e) => setName(e.target.value)} /></label>
      <label className="flex flex-col gap-1.5">{msg("描述")}<input className="input" value={description} disabled={busy} onChange={(e) => setDescription(e.target.value)} /></label>
      <label className="flex flex-col gap-1.5">{msg("工具指令")}<textarea className="input min-h-40" placeholder={msg("描述工具的用途、执行步骤和输出要求…")} value={content} disabled={busy} onChange={(e) => setContent(e.target.value)} /></label>
      <p className="m-0 text-xs leading-6 text-ink3">{kind === 'skill' ? msg("保存为 skills/{0}/SKILL.md。", {0: name || msg('<名称>')}) : msg("创建 plugins/{0}/，包含插件清单和一个 Skill，并登记到共享 marketplace。", {0: name || msg('<名称>')})} {msg("创建后可继续用编辑器修改文件。")}</p>
    </form>
    {error != null && <ErrorBox error={error} />}
  </SimpleDialog>;
}

export function SharedRepositoryPanel() {
  useLocale();
  const api = useApi();
  const qc = useQueryClient();
  const query = useSharedRepository();
  const toast = useToast();
  const [remote, setRemote] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState<unknown>(null);
  const run = async (action: string, fn: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(action); setError(null);
    try { await fn(); await qc.invalidateQueries(); toast.push({ tone: 'ok', title: msg("{0}完成", {0: action}) }); }
    catch (e) { setError(e); await query.refetch(); }
    finally { setBusy(''); }
  };
  const status = query.data;
  if (!status?.initialized) return null;
  return <section className="glass flex flex-col gap-3.5 rounded-[8px] p-4" aria-label={msg("共享仓库版本管理")}>
    <div><h2 className="m-0 text-lg font-semibold">{msg("共享仓库 · Git")}</h2><p className="mono mb-0 break-all text-xs text-ink3">{status.root} · {status.branch || msg("无分支")} · {status.head ? status.head.slice(0, 7) : msg("尚未提交")}</p></div>
    <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void run(msg("保存远程地址"), () => api.setSharedRemote(remote ?? status.remote)); }}>
      <label className="flex min-w-60 flex-1 flex-col gap-1.5">{msg("远程仓库地址")}<input className="input mono" placeholder="git@github.com:your-name/agent-tools.git" value={remote ?? status.remote} disabled={!!busy} onChange={(e) => setRemote(e.target.value)} /></label>
      <button className="btn btn-g" disabled={!!busy || !(remote ?? status.remote).trim()}>{msg("保存远程地址")}</button>
    </form>
    <p className="m-0 text-xs leading-6 text-ink3">{msg("先在 GitHub 创建空仓库，再填入地址。认证使用本机 Git 凭据或 SSH。只有点击“推送”才上传已提交内容。")}</p>
    {!status.registryIncluded && <p className="m-0 text-sm text-warn-ink">{msg("MCP registry 位于共享仓库外，不会随此仓库提交或推送。")}</p>}
    <details><summary className="cursor-pointer text-sm">{msg("待提交文件（{0}）", {0: status.changes.length})}</summary><pre className="mono max-h-48 overflow-auto text-xs">{status.changes.join('\n') || msg("没有改动")}</pre></details>
    <form className="flex flex-wrap gap-2" onSubmit={(e) => { e.preventDefault(); void run(msg("提交"), () => api.commitSharedRepository(message)); }}>
      <label className="flex min-w-60 flex-1 flex-col gap-1.5">{msg("提交说明")}<input className="input" placeholder={msg("说明本次工具修改")} value={message} disabled={!!busy} onChange={(e) => setMessage(e.target.value)} /></label>
      <button className="btn btn-g self-end" disabled={!!busy || !message.trim() || !status.changes.length}>{busy === msg("提交") ? msg("提交中…") : msg("提交改动")}</button>
      <button type="button" className="btn btn-p self-end" disabled={!!busy || !status.remote || !status.head} onClick={() => void run(msg("推送"), () => api.pushSharedRepository())}>{busy === msg("推送") ? msg("推送中…") : msg("推送")}</button>
    </form>
    {error != null && <ErrorBox error={error} />}
  </section>;
}
