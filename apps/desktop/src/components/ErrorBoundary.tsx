import { Component, useState, type ReactNode } from 'react';
import { useLang } from '../i18n';
import { scrubErrorText } from '../utils/scrub';

/**
 * 桌面端全局错误兜底（H2）。
 * - ErrorBoundary：捕获子树渲染期错误，展示人性化兜底页（导出日志 / 重新加载）。
 * - 全局捕获：window 'error' + 'unhandledrejection' 记入内存环形日志（最近 200 条），
 *   不打扰用户；renderer 崩溃不再是白屏或静默。
 */

// ---------------------------------------------------------------------------
// 环形错误日志（内存，进程内）
// ---------------------------------------------------------------------------

export interface ErrorRecord {
  /** ISO 时间戳 */
  ts: string;
  /** 来源：render=渲染期被 ErrorBoundary 捕获，window=全局 error 事件，rejection=未处理的 Promise */
  kind: 'render' | 'window' | 'rejection';
  message: string;
  /** 堆栈摘要（前 6 行，截断防爆） */
  stack?: string;
}

const MAX_RECORDS = 200;
const records: ErrorRecord[] = [];

function summarizeStack(stack: unknown): string | undefined {
  if (typeof stack !== 'string' || !stack) return undefined;
  return stack.split('\n').slice(0, 6).join('\n').slice(0, 800);
}

/** 记一条错误（内部 + 供 componentDidCatch / 全局监听调用）。 */
export function pushError(kind: ErrorRecord['kind'], message: string, stack?: unknown): void {
  records.push({
    ts: new Date().toISOString(),
    kind,
    message: String(message ?? '').slice(0, 500),
    stack: summarizeStack(stack),
  });
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
}

/** 导出为人类可读文本（下载用）。导出层做密钥脱敏（P3）。 */
export function getErrorLogText(): string {
  const head = [
    `AI Factory error log`,
    `exported: ${new Date().toISOString()}`,
    `userAgent: ${typeof navigator !== 'undefined' ? navigator.userAgent : 'n/a'}`,
    `records: ${records.length}`,
    `---`,
  ];
  const body = records.map(
    (r) =>
      `[${r.ts}] [${r.kind}] ${scrubErrorText(r.message)}` +
      (r.stack ? `\n${scrubErrorText(r.stack)}` : ''),
  );
  return [...head, ...body].join('\n') + '\n';
}

let installed = false;
/** 安装全局 error / unhandledrejection 捕获（幂等）。 */
export function installGlobalErrorCapture(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  window.addEventListener('error', (e) => {
    pushError('window', e.message || 'unknown window error', (e as ErrorEvent).error?.stack);
  });
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    const reason = e.reason as { message?: string; stack?: string } | null | undefined;
    pushError(
      'rejection',
      (reason && reason.message) || String(reason ?? 'unknown rejection'),
      reason?.stack,
    );
  });
}

// 模块加载即安装：App 必经此模块，保证捕获从启动第一刻生效。
installGlobalErrorCapture();

// ---------------------------------------------------------------------------
// 兜底页（函数组件，可用 useLang 双语）
// ---------------------------------------------------------------------------

function downloadLog(): void {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  const name =
    `ai-factory-error-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-` +
    `${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.log`;
  const blob = new Blob([getErrorLogText()], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function ErrorFallback({ message }: { message: string }) {
  const { t } = useLang();
  const [showDetails, setShowDetails] = useState(false);
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        minHeight: '100vh', background: 'var(--bg)', color: 'var(--text)',
        padding: 24, boxSizing: 'border-box',
      }}
    >
      <div style={{ maxWidth: 520, textAlign: 'center' }}>
        <div style={{ fontSize: 44, marginBottom: 12 }}>😵</div>
        <h2 style={{ margin: '0 0 8px' }}>{t('error.title')}</h2>
        <p style={{ color: 'var(--muted)', lineHeight: 1.7, margin: '0 0 8px' }}>
          {t('error.desc')}
        </p>
        <p style={{ color: 'var(--muted)', lineHeight: 1.7, margin: '0 0 20px', fontSize: 13 }}>
          {t('error.logHint')}
        </p>
        <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginBottom: 16 }}>
          <button className="primary" onClick={downloadLog}>{t('error.exportLog')}</button>
          <button onClick={() => window.location.reload()}>{t('error.reload')}</button>
        </div>
        <button
          className="link"
          onClick={() => setShowDetails((v) => !v)}
          style={{ fontSize: 12 }}
        >
          {t('error.details')}
        </button>
        {showDetails && (
          <pre
            style={{
              marginTop: 12, textAlign: 'left', fontSize: 11, maxHeight: 160,
              overflow: 'auto', background: 'var(--bg2)', border: '1px solid var(--border)',
              borderRadius: 6, padding: 10, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            }}
          >
            {message}
          </pre>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// ErrorBoundary（类组件：只有类组件能捕获渲染期错误）
// ---------------------------------------------------------------------------

interface BoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): BoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: { componentStack?: string }): void {
    pushError('render', error.message || String(error), error.stack || info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error) {
      return <ErrorFallback message={this.state.error.message || String(this.state.error)} />;
    }
    return this.props.children;
  }
}

/** 测试/调试用：清空环形日志。 */
export function clearErrorLog(): void {
  records.length = 0;
}
