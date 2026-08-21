import { ArrowRight, Bot, GitBranch, Laptop, PlugZap, ShieldCheck, Sparkles } from 'lucide-react';
import Link from 'next/link';

const features = [
  {
    icon: Bot,
    title: 'Bring your own agents',
    description: 'Run Claude, Codex, Grok, Cursor, Kimi, Droid, Qwen, Hermes, Pi, and more through their native CLIs.',
  },
  {
    icon: Laptop,
    title: 'Give them computers',
    description: 'Use this computer, an isolated Local VM, a Box cloud desktop, or your own Linux VPS.',
  },
  {
    icon: PlugZap,
    title: 'Connect the apps you use',
    description: 'Authorize Gmail, Slack, GitHub, Notion, and hundreds of other tools with account-aware connections.',
  },
  {
    icon: ShieldCheck,
    title: 'Stay in control',
    description: 'Review risky actions in chat. Credentials remain write-only and agent processes stay on your machine.',
  },
];

export default function HomePage() {
  return (
    <main className="relative overflow-hidden">
      <div className="omb-hero-grid pointer-events-none absolute inset-x-0 top-0 h-[680px]" />
      <section className="relative mx-auto flex max-w-6xl flex-col items-center px-6 pb-20 pt-24 text-center md:pt-32">
        <div className="mb-7 inline-flex items-center gap-2 rounded-full border bg-fd-card/70 px-3 py-1.5 text-sm text-fd-muted-foreground shadow-sm backdrop-blur">
          <Sparkles className="size-4 text-blue-500" />
          Open source · local first · Apache 2.0
        </div>
        <h1 className="max-w-4xl text-balance text-5xl font-semibold tracking-[-0.045em] md:text-7xl">
          Your own team of AI agents, <span className="omb-gradient-text">in a chat app.</span>
        </h1>
        <p className="mt-7 max-w-2xl text-balance text-lg leading-8 text-fd-muted-foreground md:text-xl">
          Learn how to install OpenMausBot, connect your agent CLIs, add computers and apps, automate work, and build on the harness.
        </p>
        <div className="mt-9 flex flex-wrap justify-center gap-3">
          <Link href="/docs/getting-started/installation" className="inline-flex items-center gap-2 rounded-full bg-fd-primary px-5 py-3 font-medium text-fd-primary-foreground transition hover:opacity-90">
            Get started <ArrowRight className="size-4" />
          </Link>
          <a href="https://github.com/milind-soni/OpenMausBot" className="inline-flex items-center gap-2 rounded-full border bg-fd-background/80 px-5 py-3 font-medium transition hover:bg-fd-accent" target="_blank" rel="noreferrer">
            <GitBranch className="size-4" /> View on GitHub
          </a>
        </div>
      </section>

      <section className="relative mx-auto grid max-w-6xl gap-4 px-6 pb-24 md:grid-cols-2">
        {features.map(({ icon: Icon, title, description }) => (
          <div key={title} className="rounded-2xl border bg-fd-card/65 p-6 shadow-sm backdrop-blur transition hover:-translate-y-0.5 hover:shadow-md">
            <div className="mb-5 flex size-10 items-center justify-center rounded-xl bg-blue-500/10 text-blue-500">
              <Icon className="size-5" />
            </div>
            <h2 className="text-lg font-semibold">{title}</h2>
            <p className="mt-2 leading-7 text-fd-muted-foreground">{description}</p>
          </div>
        ))}
      </section>

      <section className="border-t bg-fd-card/35">
        <div className="mx-auto flex max-w-6xl flex-col gap-8 px-6 py-20 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-medium uppercase tracking-[0.2em] text-blue-500">Start with one bot</p>
            <h2 className="mt-3 max-w-2xl text-3xl font-semibold tracking-tight md:text-4xl">Install an agent CLI, sign in once, and OpenMausBot discovers it automatically.</h2>
          </div>
          <Link href="/docs" className="inline-flex shrink-0 items-center gap-2 font-medium text-blue-500 hover:underline">
            Browse all documentation <ArrowRight className="size-4" />
          </Link>
        </div>
      </section>
    </main>
  );
}
