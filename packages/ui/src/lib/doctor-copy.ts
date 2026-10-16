import type { DoctorIssue, DoctorReport } from '../api/types';
import { msg } from './i18n';

const COPY: Record<DoctorIssue['code'], readonly [string, string]> = {
  'broken-link': ['工具链接失效', '链接目标不可用或指向不正确。请检查共享仓库，或使用修复操作重建链接。'],
  'missing-link': ['缺少工具链接', '工具尚未正确关联到项目。请检查共享仓库，或使用修复操作补齐链接。'],
  'plaintext-secret': ['配置中存在明文密钥', '请改用环境变量引用，避免将密钥直接保存在配置中。'],
  'plugin-not-installed': ['插件尚未安装', '工具清单引用了尚未安装到应用中的插件，请先完成安装。'],
  'skill-shadowed': ['项目工具与本机工具同名', '同名工具可能互相覆盖，请确认需要保留的版本。'],
  'mcp-dup-plugin': ['工具定义重复', '清单和已启用的插件提供了同名工具，可能重复加载。请选择要保留的版本。'],
  'rev-mismatch': ['工具版本与锁定记录不一致', '共享仓库的当前版本与项目记录不同，请确认需要使用的版本。'],
  'repo-dirty': ['共享仓库有本地改动', '仓库存在尚未提交或推送的改动，请查看后决定如何处理。'],
  'plugin-global-only': ['插件可改为仅在项目中启用', '此插件在本机全局启用，但只有当前项目使用。移到项目后可减少其他项目的加载。'],
  'context-total': ['工具上下文占用', '查看各类工具的上下文占用，未测量的工具不计入总量。'],
  'project-missing': ['找不到项目目录', '项目文件夹可能已移动或删除。请重新定位，或从列表中移除项目。'],
  'config-unparseable': ['无法读取配置文件', '配置文件存在格式错误，暂时无法更新配置或检查其中的密钥。请修正格式后重新检查。'],
  'skill-dir-conflict': ['工具链接位置被占用', '预期的链接位置已有文件或文件夹。请先查看并处理冲突，现有内容不会被自动覆盖。'],
};

/** Keep backend diagnostics intact; present localized explanations independently of raw text. */
export function doctorCopy(issue: DoctorIssue, report: DoctorReport) {
  const copy = COPY[issue.code];
  if (!copy) return { title: issue.title, detail: issue.detail };
  if (issue.code === 'context-total') {
    const context = report.projects.find((project) => project.id === issue.projectId)?.context;
    if (context) return {
      title: msg('工具上下文占用：约 {0} 个词元', {0: context.total}),
      detail: msg('技能 {0} · 协议工具 {1} · 插件 {2} · 未测量 {3} 项', {0: context.skill, 1: context.mcp, 2: context.plugin, 3: context.unmeasured}),
    };
  }
  return {
    title: issue.code === 'plaintext-secret' && issue.level !== 'error' ? msg('配置中可能存在密钥') : msg(copy[0]),
    detail: msg(copy[1]),
  };
}
