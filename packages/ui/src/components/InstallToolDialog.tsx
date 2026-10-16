import { useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useApi } from '../api/context';
import type { ExternalToolSearchResult, ToolKind, ToolPackageResult, ToolPackageSource } from '../api/types';
import { msg, useLocale } from '../lib/i18n';
import { SimpleDialog } from './Dialog';
import { DirectoryInput } from './DirectoryInput';
import { Select } from './Select';
import { ErrorBox, KindChip } from './ui';
import { useToast } from './Toaster';

type Mode = 'url' | 'upload' | 'github' | 'search' | 'directory';
const MAX_BYTES = 20 * 1024 * 1024;
const key = (tool: ToolPackageResult['tools'][number]) => `${tool.kind}:${tool.name}`;
function readFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(msg('无法读取工具包，请重新选择文件')));
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.readAsDataURL(file);
  });
}

export function InstallToolDialog({ mode: initialMode, onClose }: { mode: Mode; onClose: () => void }) {
  useLocale();
  const api = useApi(), qc = useQueryClient(), toast = useToast();
  const [mode, setMode] = useState<Mode>(initialMode);
  const [url, setUrl] = useState(''), [directory, setDirectory] = useState('');
  const [ref, setRef] = useState(''), [subpath, setSubpath] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [query, setQuery] = useState(''), [kind, setKind] = useState<ToolKind>('skill');
  const [results, setResults] = useState<ExternalToolSearchResult | null>(null), [page, setPage] = useState(0);
  const [review, setReview] = useState<{ source: ToolPackageSource; result: ToolPackageResult } | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false), [picking, setPicking] = useState(false);
  const pending = useRef(false);
  const [error, setError] = useState<unknown>(null);
  const perform = async (fn: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e); }
    finally { pending.current = false; setBusy(false); }
  };
  const preview = async (source: ToolPackageSource) => {
    const result = await api.importToolPackage({ source });
    setReview({ source, result }); setSelected(result.tools.filter((t) => !t.conflict).map(key));
  };
  const run = () => perform(async () => {
    if (review) {
      if (!selected.length) return;
      await api.importToolPackage({ source: review.source, sha256: review.result.sha256, selection: selected });
      await qc.invalidateQueries();
      toast.push({ tone: 'ok', title: msg('已安装 {0} 个工具', { 0: selected.length }), detail: msg('在工具库选择工具，即可关联到项目。') });
      onClose();
    } else if (mode === 'search') {
      setResults(null); setPage(0); setResults(await api.searchExternalTools({ query: query.trim(), kind }));
    } else if (mode === 'directory') await preview({ type: 'directory', path: directory.trim() });
    else if (mode === 'github') await preview({ type: 'github', repo: url.trim(), ref: ref.trim() || undefined, path: subpath.trim() || undefined });
    else if (mode === 'url') await preview({ type: 'url', url: url.trim() });
    else {
      if (!file) throw new Error(msg('请选择工具文件'));
      if (file.size > MAX_BYTES || file.size === 0) throw new Error(msg('工具包不能为空且不能超过 20 MB'));
      await preview({ type: 'upload', filename: file.name, base64: await readFile(file) });
    }
  });
  const ready = review ? !!selected.length : mode === 'search' ? query.trim().length >= 2 : mode === 'directory' ? !!directory.trim() : mode === 'upload' ? !!file : !!url.trim();
  const reset = () => { setReview(null); setSelected([]); setError(null); };
  const title = mode === 'upload' || mode === 'directory' ? '上传工具包' : mode === 'search' ? '搜索安装' : mode === 'github' ? '从 GitHub 安装' : '从第三方下载安装';
  return <SimpleDialog open title={msg(title)} cap={msg('安装到共享仓库')} maxWidth={760} onClose={() => { if (!busy && !picking) onClose(); }} footer={<>
    <button className="btn btn-t" disabled={busy || picking} onClick={onClose}>{msg('取消')}</button>
    {review && <button className="btn btn-g" disabled={busy} onClick={reset}>{msg('重新选择')}</button>}
    <button className="btn btn-p" form="install-package" type="submit" disabled={busy || picking || !ready}>
      {msg(busy ? (review ? '安装中…' : mode === 'search' ? '搜索中…' : '读取工具包…') : review ? '确认安装' : mode === 'search' ? '搜索工具' : '预览工具包')}
    </button>
  </>}>
    <form id="install-package" className="flex min-w-0 flex-col gap-4" onSubmit={(e) => { e.preventDefault(); void run(); }}>
      {!review && <>
        <div role="tablist" aria-label={msg('安装来源')} className="flex flex-wrap gap-1">
          {([['search', '搜索'], ['url', '地址 / 包名'], ['github', 'GitHub'], ['upload', '文件'], ['directory', '文件夹']] as const).map(([value, label]) => <button key={value} type="button" role="tab" className="seg" aria-selected={mode === value} disabled={busy || picking} onClick={() => { setMode(value); setError(null); }}>{msg(label)}</button>)}
        </div>
        {mode === 'search' && <>
          <Select label={msg('工具类型')} value={kind} disabled={busy} onChange={(value) => { setKind(value); setResults(null); setPage(0); }} options={[{ value: 'skill', label: 'Skill' }, { value: 'mcp', label: 'MCP' }, { value: 'plugin', label: msg('插件') }]} />
          <label className="flex flex-col gap-2">{msg('搜索第三方工具')}<input className="input" type="search" value={query} disabled={busy} placeholder="pdf / filesystem / code review" onChange={(e) => { setQuery(e.target.value); setResults(null); }} /></label>
          <p className="m-0 text-xs leading-6 text-ink3">{msg('搜索 GitHub、Agent Skills、MCP 官方注册表和 Claude 插件市场。选择结果后预览安装内容。')}</p>
          {results?.warnings.map((warning) => <p key={warning} role="status" className="m-0 text-xs text-warn-ink">{msg(warning)}</p>)}
          {results && !results.items.length && <p role="status">{msg('没有找到匹配工具，请换个关键词或直接粘贴地址。')}</p>}
          <ul aria-label={msg('搜索结果')} className="m-0 max-h-80 list-none space-y-2 overflow-auto p-0">
            {results?.items.slice(page * 5, page * 5 + 5).map((item) => <li key={item.id} className="rounded-xl border border-line p-3">
              <div className="flex items-start justify-between gap-2"><a className="break-all font-semibold" href={item.url} target="_blank" rel="noreferrer">{item.name}</a><button type="button" className="btn btn-g btn-sm shrink-0" disabled={busy} onClick={() => void perform(() => preview(item.source))}>{msg('预览安装')}</button></div>
              <p className="mb-0 break-words text-xs leading-5 text-ink2">{item.description}</p><span className="text-xs text-ink3">{item.provider}</span>
            </li>)}
          </ul>
          {results && results.items.length > 5 && <div className="flex items-center justify-between"><button type="button" className="btn btn-t" disabled={busy || page === 0} onClick={() => setPage(page - 1)}>{msg('上一页')}</button><span className="text-xs text-ink3">{page + 1} / {Math.ceil(results.items.length / 5)}</span><button type="button" className="btn btn-t" disabled={busy || (page + 1) * 5 >= results.items.length} onClick={() => setPage(page + 1)}>{msg('下一页')}</button></div>}
        </>}
        {(mode === 'url' || mode === 'github') && <label className="flex flex-col gap-2">{msg(mode === 'github' ? 'GitHub 仓库地址' : '工具地址或 MCP 包名')}<input className="input" required value={url} disabled={busy} placeholder={mode === 'github' ? 'anthropics/skills' : 'https://…/SKILL.md / npm:@scope/server / pypi:mcp-server'} onChange={(e) => setUrl(e.target.value)} /></label>}
        {mode === 'github' && <div className="grid gap-3 sm:grid-cols-2"><label className="flex flex-col gap-2">{msg('分支、标签或提交（可选）')}<input className="input" value={ref} disabled={busy} placeholder="main" onChange={(e) => setRef(e.target.value)} /></label><label className="flex flex-col gap-2">{msg('仓库内路径（可选）')}<input className="input" value={subpath} disabled={busy} placeholder="skills/pdf" onChange={(e) => setSubpath(e.target.value)} /></label></div>}
        {mode === 'upload' && <label className="flex flex-col gap-2">{msg('本地工具文件')}<input className="min-w-0 max-w-full" type="file" accept=".md,.json,.skill,.zip" disabled={busy} onChange={(e) => { setFile(e.target.files?.[0] ?? null); setError(null); }} /></label>}
        {mode === 'directory' && <div className="flex flex-col gap-2"><label htmlFor="tool-directory">{msg('本地工具目录')}</label><DirectoryInput id="tool-directory" value={directory} onChange={setDirectory} disabled={busy} onPickingChange={setPicking} /></div>}
        {mode !== 'search' && <p className="m-0 text-sm leading-6 text-ink2">{msg('直接导入 SKILL.md、MCP JSON、plugin.json 或完整目录，也支持 .skill 和 ZIP。GitHub 会保留所选工具的脚本与资源。')}</p>}
        {mode === 'url' && <p className="m-0 text-xs leading-6 text-ink3">{msg('MCP 包示例：npm:@modelcontextprotocol/server-filesystem 或 pypi:mcp-server-fetch。依赖在 Agent 首次启动时下载。')}</p>}
      </>}
      {review && <>
        <p className="m-0 text-sm text-ink2">{msg('识别到 {0} 个工具，勾选需要安装的工具。', { 0: review.result.tools.length })}</p>
        <ul className="m-0 max-h-80 list-none space-y-3 overflow-auto p-0" aria-label={msg('待安装工具')}>
          {review.result.tools.map((tool) => <li key={key(tool)} className="rounded-xl border border-line p-3">
            <label className="flex flex-wrap items-center gap-2"><input type="checkbox" aria-label={tool.name} checked={selected.includes(key(tool))} disabled={busy || tool.conflict} onChange={(e) => setSelected((current) => e.target.checked ? [...current, key(tool)] : current.filter((k) => k !== key(tool)))} /><KindChip kind={tool.kind} /><strong className="break-all">{tool.name}</strong><span className="text-xs text-ink3">{msg('{0} 个文件', { 0: tool.files })}</span>{tool.conflict && <span className="text-sm text-err-ink">{msg('已存在，无法覆盖')}</span>}</label>
            <p className="mono mb-0 break-all text-xs text-ink3">{tool.path}</p>
          </li>)}
        </ul>
        {review.result.warnings?.map((warning) => <p key={warning} className="m-0 text-xs leading-6 text-warn-ink">{msg(warning)}</p>)}
      </>}
      <p className="m-0 text-xs leading-6 text-ink3">{msg('安装会保存工具文件，不会执行包内脚本。关联到项目后，Agent 可能运行其中的命令或插件钩子。')}</p>
      {error != null && <ErrorBox error={error} />}
    </form>
  </SimpleDialog>;
}
