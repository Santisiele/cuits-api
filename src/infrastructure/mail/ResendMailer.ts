import type { IBackupMailer } from "@ports/interfaces.js"

const ENDPOINT = "https://api.resend.com/emails"

export class ResendMailer implements IBackupMailer {
  constructor(
    private readonly apiKey: string,
    private readonly from: string,
    private readonly to: string
  ) {}

  async send(message: { subject: string; body: string; filename: string; content: Buffer }): Promise<void> {
    const response = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: this.from,
        to: [this.to],
        subject: message.subject,
        text: message.body,
        attachments: [{ filename: message.filename, content: message.content.toString("base64") }],
      }),
    })

    if (!response.ok) {
      throw new Error(`Resend answered ${response.status}: ${await response.text()}`)
    }
  }
}
