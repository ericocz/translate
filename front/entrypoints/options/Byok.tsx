import { useCallback, useEffect, useState } from 'react';
import {
  getBuyout,
  getByokConfig,
  getByokEnabled,
  setByokConfig,
  setByokEnabled,
} from '@/lib/storage';
import { PRESETS, presetById, deriveBatchBudget } from '@/lib/local-engine/presets';
import { enablePin, disablePin, isPinProtected, unlock } from '@/lib/local-engine/key-vault';
import type { ProviderConfig, ProviderFormat } from '@/lib/local-engine/types';
import type { CompatResult, CompatScore } from '@/lib/local-engine/compat-test';
import type { ByokCompatTestMsg } from '@/lib/messages';

// 表单态：ProviderConfig 全字段 + 明文 key + PIN 选项（key 不进 config 当 PIN 开时）。
interface Form extends Omit<ProviderConfig, 'batchBudget'> {
  batchBudget: number;
}

function presetToForm(id: string): Form {
  const p = presetById(id) ?? presetById('custom')!;
  return { ...p, apiKey: '' };
}

const SCORE_TEXT: Record<CompatScore, { label: string; cls: string }> = {
  good: { label: '好 · 占位符保留完整', cls: 'byok-score--good' },
  fair: { label: '中 · 偶有占位符丢失', cls: 'byok-score--fair' },
  poor: { label: '差 · 占位符频繁丢失，不建议用于翻译', cls: 'byok-score--poor' },
};

export function ByokCard() {
  const [show, setShow] = useState(false); // 买断后才显
  const [enabled, setEnabled] = useState(false);
  const [form, setForm] = useState<Form>(() => presetToForm('deepseek'));
  const [apiKey, setApiKey] = useState('');
  const [usePin, setUsePin] = useState(false);
  const [pin, setPin] = useState('');
  const [pinAlready, setPinAlready] = useState(false); // 已加密保存过（key 字段留空）
  const [saved, setSaved] = useState(false);
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<CompatResult | null>(null);
  // 软拦：评分「差」时需用户勾选「仍然使用」才允许启用。
  const [ackPoor, setAckPoor] = useState(false);

  useEffect(() => {
    void (async () => {
      const buyout = await getBuyout();
      setShow(buyout.active);
      if (!buyout.active) return;
      const [cfg, en, pinOn] = await Promise.all([
        getByokConfig(),
        getByokEnabled(),
        isPinProtected(),
      ]);
      if (cfg) setForm({ ...cfg });
      setEnabled(en);
      setUsePin(pinOn);
      setPinAlready(pinOn);
      if (cfg && !pinOn) setApiKey(cfg.apiKey ?? '');
    })();
  }, []);

  const onPreset = useCallback((id: string) => {
    setForm({ ...presetToForm(id), apiKey: '' });
    setResult(null);
    setAckPoor(false);
  }, []);

  const setField = useCallback(<K extends keyof Form>(k: K, v: Form[K]) => {
    setForm((f) => ({ ...f, [k]: v }));
    setSaved(false);
  }, []);

  const buildCfg = useCallback((): ProviderConfig => {
    const isCustom = form.id === 'custom';
    const batchBudget = isCustom
      ? deriveBatchBudget(form.contextWindow, form.maxOutput)
      : form.batchBudget;
    return { ...form, batchBudget, apiKey: apiKey.trim() };
  }, [form, apiKey]);

  const onTest = useCallback(async () => {
    setTesting(true);
    setResult(null);
    try {
      const msg: ByokCompatTestMsg = { kind: 'byok-compat-test', cfg: buildCfg() };
      const res = (await chrome.runtime.sendMessage(msg)) as CompatResult;
      setResult(res);
      if (res.ok && res.score !== 'poor') setAckPoor(false);
    } catch {
      setResult({ ok: false, error: { kind: 'unknown', message: '测试失败，请重试' } });
    } finally {
      setTesting(false);
    }
  }, [buildCfg]);

  // 软拦：测出「差」且未勾选「仍然使用」时，禁止启用。
  const blockedByPoor = result?.ok && result.score === 'poor' && !ackPoor;

  const onSave = useCallback(async () => {
    const cfg = buildCfg();
    const wantEnable = enabled && !blockedByPoor;
    if (usePin) {
      // 开 PIN：必须有 PIN；加密明文 key、config 不存明文；立即解锁本会话。
      if (pin.length < 4) {
        alert('请设置至少 4 位 PIN');
        return;
      }
      await setByokConfig({ ...cfg, apiKey: '' });
      await enablePin(apiKey.trim(), pin);
      await unlock(pin);
      setPinAlready(true);
    } else {
      await setByokConfig(cfg);
      await disablePin();
      setPinAlready(false);
    }
    await setByokEnabled(wantEnable);
    setEnabled(wantEnable);
    setSaved(true);
  }, [buildCfg, enabled, blockedByPoor, usePin, pin, apiKey]);

  if (!show) {
    return (
      <section className="card">
        <div className="card-h">
          <h2>自带模型（BYOK）</h2>
        </div>
        <p className="muted">
          买断解锁后，可在此配置「自己的模型 + key」（含本地模型），翻译由浏览器直连你的 provider，
          不经我们的服务器、不消耗平台额度。前往扩展弹窗用买断码激活后即可配置。
        </p>
      </section>
    );
  }

  const isCustom = form.id === 'custom';

  return (
    <section className="card">
      <div className="card-h">
        <h2>自带模型（BYOK）</h2>
        <button className="ghost" onClick={() => void onSave()}>
          {saved ? '已保存' : '保存'}
        </button>
      </div>
      <p className="muted">
        key 只存在你这台设备、永不上传；翻译由浏览器 service worker 直连你填的接口，不经我们服务器。
      </p>

      <label className="byok-toggle">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(e) => {
            setEnabled(e.target.checked);
            setSaved(false);
          }}
        />
        <span>启用自带模型翻译（关闭则仍走平台额度）</span>
      </label>

      <div className="byok-field">
        <label>模型预设</label>
        <select value={form.id} onChange={(e) => onPreset(e.target.value)}>
          {PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
          <option value="custom">自定义</option>
        </select>
      </div>

      <div className="byok-field">
        <label>接口地址 endpoint</label>
        <input
          type="text"
          value={form.endpoint}
          placeholder="https://api.example.com/v1/chat/completions"
          onChange={(e) => setField('endpoint', e.target.value)}
        />
      </div>

      <div className="byok-field">
        <label>模型 model</label>
        <input
          type="text"
          value={form.model}
          placeholder="model-id"
          onChange={(e) => setField('model', e.target.value)}
        />
      </div>

      <div className="byok-field">
        <label>API Key{form.endpoint.includes('localhost') ? '（本地模型可留空）' : ''}</label>
        <input
          type="password"
          value={apiKey}
          placeholder={pinAlready ? '已加密保存；如需更换请重新填入' : 'sk-...'}
          autoComplete="off"
          onChange={(e) => {
            setApiKey(e.target.value);
            setSaved(false);
          }}
        />
      </div>

      {isCustom && (
        <>
          <div className="byok-field">
            <label>接口格式 format</label>
            <select
              value={form.format}
              onChange={(e) => setField('format', e.target.value as ProviderFormat)}
            >
              <option value="openai">OpenAI 兼容（DeepSeek / Kimi / GLM / 本地等）</option>
              <option value="anthropic">Anthropic（Claude）</option>
            </select>
          </div>
          <div className="byok-grid2">
            <div className="byok-field">
              <label>上下文窗口 token</label>
              <input
                type="number"
                value={form.contextWindow}
                onChange={(e) => setField('contextWindow', Number(e.target.value) || 0)}
              />
            </div>
            <div className="byok-field">
              <label>输出上限 token</label>
              <input
                type="number"
                value={form.maxOutput}
                onChange={(e) => setField('maxOutput', Number(e.target.value) || 0)}
              />
            </div>
          </div>
        </>
      )}

      {/* PIN 加密 */}
      <label className="byok-toggle">
        <input
          type="checkbox"
          checked={usePin}
          onChange={(e) => {
            setUsePin(e.target.checked);
            setSaved(false);
          }}
        />
        <span>用 PIN 加密本地 key（更安全；浏览器重启后需在弹窗输入 PIN 解锁）</span>
      </label>
      {usePin && (
        <div className="byok-field">
          <label>PIN（至少 4 位）</label>
          <input
            type="password"
            value={pin}
            placeholder={pinAlready ? '重新设置 PIN' : '设置 PIN'}
            autoComplete="off"
            onChange={(e) => setPin(e.target.value)}
          />
        </div>
      )}

      {/* 兼容性自检 */}
      <div className="kbd-row">
        <span className="muted">测一下所选模型对占位符协议的遵守度（会真实调用一次）。</span>
        <button className="ghost" onClick={() => void onTest()} disabled={testing || !form.endpoint || !form.model}>
          {testing ? '测试中…' : '测试兼容性'}
        </button>
      </div>

      {result && !result.ok && (
        <div className="byok-score byok-score--poor">测试失败：{result.error?.message}</div>
      )}
      {result?.ok && result.score && (
        <div className={'byok-score ' + SCORE_TEXT[result.score].cls}>
          兼容性：{SCORE_TEXT[result.score].label}
          <span className="muted">
            （{result.passed}/{result.total} 段标记完整）
          </span>
        </div>
      )}
      {blockedByPoor && (
        <label className="byok-toggle byok-ack">
          <input type="checkbox" checked={ackPoor} onChange={(e) => setAckPoor(e.target.checked)} />
          <span>我知道此模型对占位符支持不佳（可能丢链接/丢字），仍要启用</span>
        </label>
      )}
    </section>
  );
}
