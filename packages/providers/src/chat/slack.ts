import { webhookPoster } from "../automation/webhook.js";

// Slack: an incoming webhook posts the office's events into a channel. The
// URL must be Slack's own webhook host, and goes through the same public-only
// POST as every other webhook.

export interface Chat {
  readonly name: string;
  send(text: string): Promise<void>;
}

export const SLACK_WEBHOOK = /^https:\/\/hooks\.slack\.com\/services\/[\w/-]+$/;

export function slack(url: string): Chat {
  if (!SLACK_WEBHOOK.test(url)) throw new Error("Use the Slack incoming-webhook URL (https://hooks.slack.com/services/…)");
  return { name: "slack", send: async (text) => void (await webhookPoster.post(url, { text })) };
}
