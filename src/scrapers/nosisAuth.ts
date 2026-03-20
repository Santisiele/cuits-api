import { chromium } from "playwright"
import { CookieJar } from "tough-cookie"
import { config } from "@config"

const LOGIN_URL = "https://sac31.nosis.com/net/manager"

/**
 * Logs in to Nosis Manager using a real browser and returns
 * the session cookies for use in subsequent HTTP requests
 */
export async function nosisLogin(): Promise<{ jar: CookieJar; baseUrl: string }> {
  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext()
  const page = await context.newPage()

  try {
    await page.goto(LOGIN_URL)
    await page.fill("#Email", config.nosis.user)
    await page.fill("#Clave", config.nosis.password)
    await page.click("#btnSubmit")
    await page.waitForURL("**/manager**", { timeout: 10000 })

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