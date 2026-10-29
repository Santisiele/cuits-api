import type { IBackupMailer, ITextMailer } from "@ports/interfaces.js"

const ENDPOINT = "https://api.resend.com/emails"

export class ResendMailer implements IBackupMailer, ITextMailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly to: string
  ) {}

  async send(message: { subject: string; body: string; filename: string; content: Buffer }): Promise<void> {
    await this.post({
      subject: message.subject,
      text: message.body,
      attachments: [{ filename: message.filename, content: message.content.toString("base64") }],
    })
  }

  async sendText(message: { subject: string; body: string }): Promise<void> {
    await this.post({ subject: message.subject, text: message.body })
  }

  private async post(payload: Record<string, unknown>): Promise<void> {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: this.from, to: [this.to], ...payload }),
    })

    if (!response.ok) {
      throw new Error(`Resend answered ${response.status}: ${await response.text()}`)
    }
  }
}
