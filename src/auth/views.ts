import type { Profile } from './accounts.js';

export function escape(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]!);
}

export function page(title: string, content: string, message?: string) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escape(title)} · ReelTone</title>
  <style>
    :root { color-scheme: dark; font-family: system-ui,sans-serif; color: #edf3f6; background: #11171b }
    body { min-height: 100dvh; margin: 0; display: grid; place-items: center }
    main { box-sizing: border-box; margin: 1rem; width: min(30rem,calc(100% - 2rem)); padding: clamp(1.25rem,5vw,2.5rem);
      background: #1a2329; border: 1px solid #37474f; border-radius: .85rem }
    h1 { font-size: 1.75rem; margin: .4rem 0 1.25rem }
    p { margin: .75rem 0; line-height: 1.5 } strong { color: #94dec9 }
    form { display: grid; gap: .9rem; margin: 1rem 0 }
    label { display: grid; gap: .3rem } input,button { font: inherit; padding: .65rem; border-radius: .35rem }
    input { color: inherit; background: #11171b; border: 1px solid #60747d }
    button { cursor: pointer; font-weight: 650; color: #10221c; background: #94dec9; border: 1px solid #94dec9 }
    .secondary button { color: inherit; background: transparent; border-color: #60747d }
    a { color: #a1e6d3 } a:focus-visible,button:focus-visible,input:focus-visible { outline: 2px solid #d4fb9d; outline-offset: 3px }
    [role=alert] { color: #ffcfb8 } .links { display: flex; justify-content: space-between; flex-wrap: wrap; gap: .6rem }
  </style>
</head>
<body><main><strong>ReelTone</strong><h1>${escape(title)}</h1>
${message ? `<p role="alert">${escape(message)}</p>` : ''}${content}</main></body></html>`;
}

export function hidden(name: string, value: string) {
  return `<input type="hidden" name="${name}" value="${escape(value)}">`;
}

export function form(action: string, csrf: string, fields: string, button: string, secondary = false) {
  return `<form method="post" action="${escape(action)}"${secondary ? ' class="secondary"' : ''}>
  ${hidden('csrf', csrf)}${fields}<button type="submit">${escape(button)}</button></form>`;
}

export function emailInput(value = '') {
  return `<label>Email<input type="email" autocomplete="email" name="email" value="${escape(value)}" maxlength="254" required></label>`;
}

export function passwordInput(existing = false) {
  return `<label>${existing ? 'Password' : 'New password'}
  <input type="password" name="password" autocomplete="${existing ? 'current-password' : 'new-password'}"
  ${existing ? '' : 'minlength="15" '}maxlength="512" required></label>`;
}

export function profileInputs(identity?: Partial<Profile>) {
  const username = identity?.username?.replace(/-/g, '_').slice(0, 30) ?? '';
  return `<label>Username<input name="username" autocomplete="username" maxlength="30" minlength="3"
    pattern="[A-Za-z0-9_]{3,30}" value="${escape(username)}" required></label>
  <label>First name<input name="firstName" autocomplete="given-name" maxlength="100" value="${escape(identity?.firstName ?? '')}"></label>
  <label>Last name<input name="lastName" autocomplete="family-name" maxlength="100" value="${escape(identity?.lastName ?? '')}"></label>
  <label>Profile picture URL<input name="picture" type="url" maxlength="2048" value="${escape(identity?.picture ?? '')}"></label>`;
}

export const codeInput = `<label>Email verification code
  <input name="code" autocomplete="one-time-code" inputmode="numeric" pattern="[0-9]{6}" maxlength="6" required></label>`;
