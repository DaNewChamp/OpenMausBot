const OTP_PATTERN = /one-time code is:\s*(\d{8})/i;

export interface LocalMailMessage {
  to: string;
  subject?: string;
  text?: string;
  html?: string;
}

export interface LocalMailFixture {
  EMAIL: {
    send(message: LocalMailMessage): Promise<void>;
  };
  readLatestOtp(email: string): string;
  clear(): void;
}

function normalizedEmail(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function messageText(message: LocalMailMessage): string {
  return [message.text, message.html].filter((value): value is string => typeof value === "string").join("\n");
}

export function createLocalMailFixture(): LocalMailFixture {
  const messages: LocalMailMessage[] = [];
  const EMAIL = {
    async send(message: LocalMailMessage): Promise<void> {
      const to = normalizedEmail(message?.to);
      if (!to) throw new Error("local mail recipient is required");
      messages.push({
        to,
        subject: typeof message.subject === "string" ? message.subject : undefined,
        text: typeof message.text === "string" ? message.text : undefined,
        html: typeof message.html === "string" ? message.html : undefined,
      });
    },
  };

  return {
    EMAIL,
    readLatestOtp(email: string): string {
      const recipient = normalizedEmail(email);
      if (!recipient) throw new Error("local mail recipient is required");
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.to !== recipient) continue;
        const match = messageText(message).match(OTP_PATTERN);
        if (match) return match[1];
      }
      throw new Error("local OTP message not found");
    },
    clear(): void {
      messages.length = 0;
    },
  };
}
