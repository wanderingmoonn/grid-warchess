/**
 * 聊天输入框：把"输入法还在组字"和"我要发送"分开。
 *
 * 为什么要单独一层：中文一句话要打几个字才组成词，按 Enter 是**选词**。
 * 那一刻输入框里的值只有已经上屏的部分，剩下的还在输入法里——
 * 不拦这一步，选词那一下就会把半句话发出去。发的人以为自己发的是整句，
 * 对面收到的是残句，两边都没察觉。
 *
 * 为什么不能只靠默认行为：浏览器对"组字中按 Enter 要不要提交表单"处理不一致
 * （Chrome 拦、Safari 放行），所以自己记一个组字状态，不赌实现。
 *
 * 为什么抽成函数：jsdom 里能真的派发 `compositionstart` / `submit` 来测。
 * 写在 main.ts 里就只能靠肉眼看了。
 */
export function bindChatComposer(input: HTMLInputElement, send: () => void): void {
  let composing = false;

  input.addEventListener('compositionstart', () => {
    composing = true;
  });
  input.addEventListener('compositionend', () => {
    composing = false;
  });
  // 兜底：某些环境不发 compositionend（失焦、被别的事件打断），
  // 下一次"不在组字中的按键"就把状态清掉，免得从此再也发不出消息
  input.addEventListener('keydown', (e) => {
    if (!e.isComposing) composing = false;
  });

  input.closest('form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    if (composing) return; // 这次 Enter 归输入法：只是选词，不是发送
    send();
  });
}
