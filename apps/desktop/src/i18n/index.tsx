import { createContext, useContext, useState, type ReactNode } from 'react';
import { zh, type I18nKey } from './zh';
import { en } from './en';

/**
 * 轻量 i18n 基础设施（i18n 试点，Batch 237）——零外部依赖。
 * - `zh` 为默认语言（现有用户不受影响）；`en` 为英文包。
 * - 语言选择存 `localStorage['ai-factory:lang']`，非法值回退 `zh`。
 * - `t(key, vars)`：key 缺失时原样返回 key（目检可发现）；插值 `{name}`
 *   缺失时保留 `{name}` 原样（目检可发现），不静默吞掉。
 */
export type Lang = 'zh' | 'en';
export type TFunc = (key: I18nKey | string, vars?: Record<string, string | number>) => string;

const PACKS: Record<Lang, Record<string, string>> = { zh, en };
const STORAGE_KEY = 'ai-factory:lang';

function interpolate(template: string, vars?: Record<string, string | number>): string {
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (m, k: string) =>
    Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m,
  );
}

interface LangCtx {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: TFunc;
  /** 当前语言包是否包含 key（用于"按 key 翻译、缺 key 回退原文"的场景，如服务端下发的 stat 展示字段）。 */
  has: (key: string) => boolean;
}

const Ctx = createContext<LangCtx>({
  lang: 'zh',
  setLang: () => {},
  t: (k) => k,
  has: () => false,
});

function readStoredLang(): Lang {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'en' ? 'en' : 'zh';
  } catch {
    return 'zh';
  }
}

export function LanguageProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readStoredLang);
  const setLang = (l: Lang) => {
    setLangState(l);
    try {
      window.localStorage.setItem(STORAGE_KEY, l);
    } catch {
      /* 存储不可用时仅本次会话生效，不抛错 */
    }
  };
  const t: TFunc = (key, vars) => interpolate(PACKS[lang][key] ?? key, vars);
  const has = (key: string): boolean => Object.prototype.hasOwnProperty.call(PACKS[lang], key);
  return <Ctx.Provider value={{ lang, setLang, t, has }}>{children}</Ctx.Provider>;
}

export function useLang(): LangCtx {
  return useContext(Ctx);
}
