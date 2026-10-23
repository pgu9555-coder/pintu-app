'use strict'
// Headless CSS/markup proxy, not a substitute for WeChat device rendering.
// Set PLAYWRIGHT_MODULE to an installed playwright package when it is not on NODE_PATH.
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright')
const root = path.resolve(__dirname, '../miniprogram-shell')
const read = file => fs.readFileSync(path.join(root, file), 'utf8')
const nativeDefaults = 'html,body{margin:0}view,scroll-view{display:block}block{display:contents}text{display:inline}button{box-sizing:border-box;display:block;margin-left:auto;margin-right:auto;padding:0 14px;line-height:2.55555556;border:0}button:not([size=mini]){width:calc(100% - 64px)}button[size=mini]{display:inline-block;line-height:2.3;font-size:13px;padding:0 1.34em}input{box-sizing:border-box;min-width:0}'
async function render(page, name, data, scale) {
  const width = page.viewportSize().width
  const css = (read('app.wxss') + '\n' + read(`pages/${name}/index.wxss`)).replace(/\bpage\s*\{/g, 'body{').replace(/\bimage\b/g, 'img').replace(/([\d.]+)rpx/g, (_, n) => `${Number(n) * width / 750}px`)
  const markup = read(`pages/${name}/index.wxml`).replace(/<image\b/g, '<img').replace(/<\/image>/g, '')
  await page.setContent(`<style>${nativeDefaults}\n${css}</style><main>${markup}</main>`)
  await page.evaluate(({ data, scale }) => {
    const expression = (text, state) => { try { return Function('s', `with(s){return (${text})}`)(state) } catch (_) { return '' } }
    const value = (text, state) => text.replace(/{{([\s\S]*?)}}/g, (_, expr) => expression(expr, state) ?? '')
    function walk(parent, state) {
      let branch = false
      for (const node of Array.from(parent.childNodes)) {
        if (node.nodeType === 3) { node.textContent = value(node.textContent, state); continue }
        if (node.nodeType !== 1) continue
        const has = key => node.hasAttribute(key)
        const attr = key => node.getAttribute(key)
        if (has('wx:if')) { branch = Boolean(expression(attr('wx:if').slice(2, -2), state)); if (!branch) { node.remove(); continue } }
        else if (has('wx:elif')) { const show = !branch && Boolean(expression(attr('wx:elif').slice(2, -2), state)); branch ||= show; if (!show) { node.remove(); continue } }
        else if (has('wx:else')) { if (branch) { node.remove(); continue } branch = true }
        else branch = false
        if (has('wx:for')) {
          const items = expression(attr('wx:for').slice(2, -2), state) || []
          items.forEach((item, index) => { const wrapper = document.createElement('block'); const copy = node.cloneNode(true); copy.removeAttribute('wx:for'); wrapper.append(copy); node.before(wrapper); walk(wrapper, { ...state, item, index }) })
          node.remove(); continue
        }
        for (const attribute of Array.from(node.attributes)) {
          if (attribute.name.startsWith('wx:')) node.removeAttribute(attribute.name)
          else node.setAttribute(attribute.name, value(attribute.value, state))
        }
        walk(node, state)
      }
    }
    walk(document.querySelector('main'), data)
    if (scale !== 1) for (const element of document.querySelectorAll('main *')) element.style.fontSize = `${parseFloat(getComputedStyle(element).fontSize) * scale}px`
  }, { data, scale })
}
async function main() {
  const browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) })
  try {
    const page = await browser.newPage()
    let cases = 0
    for (const width of [320, 375, 390, 430]) for (const scale of [1, 1.4]) {
      await page.setViewportSize({ width, height: 900 })
      await render(page, 'profile', { canChooseAvatar: true, nickname: '很长的昵称'.repeat(4), avatar: '', busy: false }, scale)
      const badge = await page.locator('.avatar-badge').boundingBox()
      assert.ok(badge.width <= 40 && badge.width === badge.height, `camera circle ${width}/${scale}: ${JSON.stringify(badge)}`)
      const common = { headerTopPx: 72, screen: 'main', resultMode: false, name: '很长的昵称'.repeat(4), accountAvatar: '', busy: false }
      await render(page, 'midpoint', { ...common, room: null, code: 'ABCD1234' }, scale)
      assert.equal(await page.locator('.point-card').count(), 0, 'no departure editor before joining')
      const input = await page.locator('.code-input').boundingBox()
      assert.ok(input.width >= 150, `room code input too narrow ${width}/${scale}: ${input.width}`)
      await checkBounds(page, width, `entry ${width}/${scale}`)
      await render(page, 'midpoint', { ...common, room: { code: 'ABCD1234' }, isOwner: true, people: [{ uid: 'a', name: common.name, isSelf: true, address: '非常长的地址'.repeat(15) }, { uid: 'b', name: '另一个很长的昵称'.repeat(3), address: '' }], mineEditorOpen: false, center: null }, scale)
      const buttons = await page.locator('.active-room-actions button').all()
      assert.equal(buttons.length, 4)
      const boxes = await Promise.all(buttons.map(button => button.boundingBox()))
      assert.ok(Math.abs(boxes[0].y - boxes[1].y) < 1 && boxes[2].y > boxes[0].y && Math.abs(boxes[2].y - boxes[3].y) < 1, 'owner actions form two rows of two')
      await checkBounds(page, width, `room ${width}/${scale}`)
      await render(page, 'midpoint', { ...common, room: { code: 'ABCD1234' }, isOwner: false, people: [{ uid: 'a', name: common.name, isSelf: true, address: '' }], mineEditorOpen: true, mineHasSavedLocation: true, mineAddress: '非常长的地址'.repeat(15), center: null, amapConfigured: false }, scale)
      assert.equal(await page.locator('.active-room-actions button').count(), 3, 'member has copy/share/leave actions')
      assert.equal(await page.locator('.active-room-actions').getByText('转交房主').count(), 0)
      await checkBounds(page, width, `editor ${width}/${scale}`)
      cases += 4
    }
    console.log(`Native mobile CSS proxy passed: ${cases} cases, 320/375/390/430px, 100%/140% fonts, long names/addresses, simulated native button defaults. Real WeChat/device rendering is not covered.`)
  } finally { await browser.close() }
}
async function checkBounds(page, width, label) {
  const overflow = await page.evaluate(width => Array.from(document.querySelectorAll('main button, main input, main .point-copy, main .identity-name')).filter(node => { const box = node.getBoundingClientRect(); return box.width && (box.left < -1 || box.right > width + 1 || node.scrollWidth > node.clientWidth + 2 && node.tagName === 'BUTTON') }).map(node => ({ class: node.className, width: node.getBoundingClientRect().width, scroll: node.scrollWidth, client: node.clientWidth })), width)
  assert.deepEqual(overflow, [], `${label}: interactive controls stay within viewport and button labels fit`)
}
main().catch(error => { console.error(error); process.exitCode = 1 })
