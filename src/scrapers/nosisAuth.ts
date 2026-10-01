import os from "os"
import path from "path"
import { chromium, type Locator, type Page } from "playwright"
import { CookieJar } from "tough-cookie"
import { config } from "@config.js"

const LOGIN_URL = "https://sac31.nosis.com/net/manager"
const MAX_LOGIN_STEPS = 8
const MAX_PASSWORD_SUBMITS = 2
const STEP_TIMEOUT_MS = 30_000
const SUBMIT_LABEL = /^\s*(siguiente|continuar|ingresar|iniciar sesi[oó]n|acceder|entrar)\s*$/i

function isManager(url: URL): boolean {
  return /^sac\d*\.nosis\.com$/i.test(url.hostname) && url.pathname.toLowerCase().startsWith("/net/manager")
}

async function firstVisible(locator: Locator): Promise<Locator | null> {
  const count = await locator.count()
  for (let i = 0; i < count; i++) {
    const candidate = locator.nth(i)
    if (await candidate.isVisible()) return candidate
  }
  return null
}

async function failWithScreenshot(page: Page, step: string, cause: string): Promise<never> {
  const file = path.join(os.tmpdir(), `nosis-login-${Date.now()}.png`)
  await page.screenshot({ path: file, fullPage: true }).catch(() => undefined)
  throw new Error(`Nosis login stuck at "${step}" on ${page.url()} (screenshot: ${file}): ${cause}`)
}

async function submit(page: Page, field: Locator): Promise<void> {
  const button = await firstVisible(page.getByRole("button", { name: SUBMIT_LABEL }))
  if (button) await button.click()
  else await field.press("Enter")
}

async function waitForNextScreen(
  page: Page,
  before: string,
  submitted: Locator | null,
  submittedPassword: boolean
): Promise<void> {
  const signals = [page.waitForURL((url) => url.href !== before, { timeout: STEP_TIMEOUT_MS })]
  if (submitted) signals.push(submitted.waitFor({ state: "hidden", timeout: STEP_TIMEOUT_MS }))
  if (submitted && !submittedPassword) {
    signals.push(page.locator('input[type="password"]:visible').first().waitFor({ timeout: STEP_TIMEOUT_MS }))
  }
  await Promise.race(signals).catch(() => undefined)
  await page.waitForLoadState("domcontentloaded").catch(() => undefined)
}

async function walkLoginScreens(page: Page): Promise<void> {
  let passwordSubmits = 0
  for (let step = 1; step <= MAX_LOGIN_STEPS; step++) {
    if (isManager(new URL(page.url()))) return

    const password = await firstVisible(page.locator('input[type="password"]'))
    const user = await firstVisible(page.locator('input[type="email"], input[type="text"]'))
    const before = page.url()

    if (user && (await user.inputValue()) === "") await user.fill(config.nosis.user)

    if (password) {
      if (passwordSubmits === MAX_PASSWORD_SUBMITS) {
        await failWithScreenshot(page, "password", "asked for the password again, check NOSIS_USER and NOSIS_PASSWORD")
      }
      passwordSubmits++
      await password.fill(config.nosis.password)
      await submit(page, password)
    } else if (user) {
      await submit(page, user)
    } else {
      await page.goto(LOGIN_URL)
    }

    await waitForNextScreen(page, before, password ?? user, password !== null)
  }

  if (!isManager(new URL(page.url()))) {
    await failWithScreenshot(page, `login screens (${MAX_LOGIN_STEPS} steps)`, "never reached the manager")
  }
}

/**
 * Logs in to Nosis Manager using a real browser and returns
 * the session cookies for use in subsequent HTTP requests
 */
export async function nosisLogin(): Promise<{ jar: CookieJar; baseUrl: string }> {
  const browser = await chromium.launch({ headless: false, slowMo: 300 })
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    await page.goto(LOGIN_URL)
    await walkLoginScreens(page)

    // Nosis assigns a dynamic server after login, capture the actual base URL
    const currentUrl = new URL(page.url())
    const baseUrl = `${currentUrl.protocol}//${currentUrl.host}`

    const cookies = await context.cookies()
    const jar = new CookieJar()

    for (const cookie of cookies) {
      await jar.setCookie(
        `${cookie.name}=${cookie.value}; Domain=${cookie.domain}; Path=${cookie.path}`,
        `https://${cookie.domain}`
      )
    }

    return { jar, baseUrl }
  } finally {
    await browser.close()
  }
}
