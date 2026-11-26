import { useState } from 'react';
import { browser } from 'wxt/browser';
import { useReadAuth } from '@/entrypoints/hooks/useReadAuth';
import { READ_OFFER_ID } from '@/entrypoints/utils/readTask';
import Icon from './Icon';

interface Receipt {
    accepted?: boolean;
    reason?: string;
}

interface AuthReply {
    ok?: boolean;
    message?: string;
}

type Busy = 'open' | 'verify' | 'clear' | 'submit' | null;
type NoticeTone = 'info' | 'ok' | 'error';

interface Notice {
    tone: NoticeTone;
    text: string;
}

const AUTHORIZED_AT = new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
});

// 阅读任务的授权入口。原脚本用 Tampermonkey 菜单 + prompt/alert 完成这件事；
// 在扩展里，入口、状态和结果都在这一块里，不弹页面级对话框。
function ReadAuthPanel() {
    const { isLoaded, authorized, auth } = useReadAuth();
    const [busy, setBusy] = useState<Busy>(null);
    const [notice, setNotice] = useState<Notice | null>(null);
    const [manualOpen, setManualOpen] = useState(false);
    const [manualValue, setManualValue] = useState('');
    const [confirmClear, setConfirmClear] = useState(false);

    const blocked = busy != null;

    async function openAuthorization(): Promise<void> {
        setBusy('open');
        setNotice(null);
        try {
            const receipt = await browser.runtime.sendMessage({ action: 'readAuthOpen' }) as Receipt | undefined;
            if (receipt?.accepted === false) {
                setNotice({ tone: 'error', text: receipt.reason || '无法打开授权页面，请重试' });
                return;
            }
            setNotice({
                tone: 'info',
                text: '已打开 Microsoft 登录页。完成登录和授权后，此弹窗会自动更新；若未更新，可重新打开扩展查看。',
            });
        } catch {
            setNotice({ tone: 'error', text: '未收到后台响应，请重试' });
        } finally {
            setBusy(null);
        }
    }

    async function verify(): Promise<void> {
        setBusy('verify');
        setNotice(null);
        try {
            const reply = await browser.runtime.sendMessage({ action: 'readAuthValidate' }) as AuthReply | undefined;
            setNotice({ tone: reply?.ok ? 'ok' : 'error', text: reply?.message || '未收到验证结果' });
        } catch {
            setNotice({ tone: 'error', text: '未收到后台响应，请重试' });
        } finally {
            setBusy(null);
        }
    }

    async function clear(): Promise<void> {
        if (!confirmClear) {
            setConfirmClear(true);
            setNotice({ tone: 'info', text: '再次点击 “确认清除” 将删除本机保存的授权信息。' });
            return;
        }
        setBusy('clear');
        setNotice(null);
        try {
            const reply = await browser.runtime.sendMessage({ action: 'readAuthClear' }) as AuthReply | undefined;
            setNotice({ tone: reply?.ok ? 'ok' : 'error', text: reply?.message || '清除授权失败，请重试' });
            setConfirmClear(false);
            setManualOpen(false);
            setManualValue('');
        } catch {
            setNotice({ tone: 'error', text: '未收到后台响应，请重试' });
        } finally {
            setBusy(null);
        }
    }

    async function submitManual(): Promise<void> {
        const value = manualValue.trim();
        if (!value) {
            setNotice({ tone: 'error', text: '请先粘贴回调地址或授权码' });
            return;
        }
        setBusy('submit');
        setNotice(null);
        try {
            const reply = await browser.runtime.sendMessage({ action: 'readAuthSubmit', value }) as AuthReply | undefined;
            setNotice({ tone: reply?.ok ? 'ok' : 'error', text: reply?.message || '未收到授权结果' });
            if (reply?.ok) {
                setManualValue('');
                setManualOpen(false);
            }
        } catch {
            setNotice({ tone: 'error', text: '未收到后台响应，请重试' });
        } finally {
            setBusy(null);
        }
    }

    return (
        <div className="read-auth">
            <div className="read-auth-state">
                <span className="read-auth-label">授权状态</span>
                <span className={`task-status${authorized ? ' task-status--done' : ''}`} role="status">
                    {!isLoaded ? '正在读取' : authorized ? '已授权' : '未授权'}
                </span>
            </div>
            {authorized && auth?.authorizedAt != null && (
                <p className="field-note">授权更新于 {AUTHORIZED_AT.format(auth.authorizedAt)}</p>
            )}
            {!authorized && isLoaded && (
                <p className="field-note">阅读任务通过 Rewards 移动端接口提交，需要一次 OAuth 授权。授权信息只保存在本机，不随设置同步。</p>
            )}
            {auth?.lastError && <p className="field-warning" role="status">{auth.lastError}</p>}

            <div className="read-auth-actions">
                <button type="button" className="btn" onClick={openAuthorization} disabled={blocked} aria-disabled={blocked}>
                    <Icon name="external-link" />
                    {busy === 'open' ? '正在打开' : authorized ? '重新授权' : '打开授权页'}
                </button>
                <button type="button" className="btn ghost-button" onClick={verify} disabled={blocked || !authorized} aria-disabled={blocked || !authorized}>
                    {busy === 'verify' ? '正在验证' : '验证授权'}
                </button>
                <button type="button" className="btn ghost-button" onClick={clear} disabled={blocked || (!authorized && !auth?.lastError)} aria-disabled={blocked || (!authorized && !auth?.lastError)}>
                    {busy === 'clear' ? '正在清除' : confirmClear ? '确认清除' : '清除授权'}
                </button>
            </div>

            {notice && (
                <p className={`read-auth-notice read-auth-notice--${notice.tone}`} role="status">{notice.text}</p>
            )}

            <div className="divider" />

            <button type="button" className="advanced-row" onClick={() => setManualOpen((open) => !open)} aria-expanded={manualOpen}>
                <span className="advanced-text">
                    <span className="advanced-title">手动粘贴回调地址</span>
                    <span className="advanced-sub">授权页没有自动完成时，把地址栏里 oauth20_desktop.srf 开头的完整地址粘贴进来</span>
                </span>
                <Icon name="chevron-right" />
            </button>
            {manualOpen && (
                <div className="read-auth-form">
                    <input
                        className="read-auth-input"
                        type="text"
                        value={manualValue}
                        onChange={(event) => setManualValue(event.target.value)}
                        onKeyDown={(event) => {
                            if (event.key === 'Enter') void submitManual();
                        }}
                        placeholder="https://login.live.com/oauth20_desktop.srf?code=…"
                        aria-label="OAuth 回调地址或授权码"
                        spellCheck={false}
                        autoComplete="off"
                    />
                    <button type="button" className="btn" onClick={submitManual} disabled={blocked} aria-disabled={blocked}>
                        {busy === 'submit' ? '正在提交' : '提交并验证'}
                    </button>
                </div>
            )}

            <p className="field-note">
                提交的 offer 为 {READ_OFFER_ID}，单轮最多 11 次、每次间隔 15–20 秒；执行期间不打开页面，也不会改变当前标签页。
            </p>
        </div>
    );
}

export default ReadAuthPanel;
