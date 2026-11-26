// login.live.com 的 desktop 回调页。原脚本让用户把地址栏内容粘贴回 prompt；
// 扩展在这里直接读 URL 里的 code 交给后台，交换成功后由后台关闭这个标签页。
// 手动粘贴仍然保留，作为回调页没被注入时的兜底。

import { defineContentScript } from '#imports';
import { browser } from 'wxt/browser';

interface ReadAuthReply {
    ok?: boolean;
    message?: string;
}

const NOTICE_ID = 'mar-read-auth-notice';

export default defineContentScript({
    matches: ['https://login.live.com/oauth20_desktop.srf*'],
    runAt: 'document_idle',
    async main() {
        const params = new URLSearchParams(location.search);
        const code = params.get('code') ?? '';
        const error = params.get('error') ?? '';
        // 用户自己打开这个页面、或回调里两者都没有时，什么都不做。
        if (!code && !error) return;

        showNotice('正在完成 Microsoft Rewards 阅读任务授权…');

        try {
            const reply = await browser.runtime.sendMessage({
                action: 'readAuthCallback',
                code,
                error,
                errorDescription: params.get('error_description') ?? '',
            }) as ReadAuthReply | undefined;

            if (reply?.ok) {
                showNotice(reply.message || '授权完成，此页面即将关闭。');
                return;
            }
            // 失败时不自动关闭：把原因留在页面上，用户还能看到。
            showNotice(`${reply?.message || '授权未能完成'}\n可以关闭此页，回到扩展重试。`);
        } catch {
            showNotice('未能连接扩展。\n请回到扩展，在阅读任务设置里粘贴本次回调地址。');
        }
    },
});

// 极简结果提示。只写 textContent，不把 URL 参数当 HTML 插入。
function showNotice(message: string): void {
    let notice = document.getElementById(NOTICE_ID);
    if (!notice) {
        notice = document.createElement('div');
        notice.id = NOTICE_ID;
        notice.style.cssText = [
            'position:fixed',
            'inset:0',
            'z-index:2147483647',
            'display:flex',
            'align-items:center',
            'justify-content:center',
            'background:#fff',
            'color:#222',
            'padding:32px',
            'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif',
            'font-size:14px',
            'line-height:1.6',
            'white-space:pre-wrap',
            'text-align:center',
        ].join(';');
        (document.body ?? document.documentElement).appendChild(notice);
    }
    notice.textContent = message;
}
