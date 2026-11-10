# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Users

Developers who already use the Pi coding agent and keep running into Gemini or Claude quota limits. They own several Google accounts and want Pi to keep working without logins, manual switching, or a heavyweight proxy. They meet the project on GitHub and in the terminal.

## Product Purpose

pi-gemini-auth is a small local rotator. It holds the user's Google Antigravity accounts, serves them to Pi behind one OpenAI-compatible endpoint on 127.0.0.1, and moves to the next account when one hits its quota. Success: Pi sees a single provider that keeps answering, and the user never sees a Google login prompt or a rate-limit error that another account could have absorbed.

## Positioning

Many accounts behind one local endpoint, with rotation that the client never notices: a rate-limited account cools down for that model only and the request continues on the next one. It is built for Pi specifically, keeps Gemini thought signatures and Claude signed thinking intact across tool calls, and has no runtime dependencies.

## Operating Context

- Runs on the developer's own machine, in the background (`pi-gemini-auth start --detach`), next to Pi.
- Set up from the terminal: `login` per Google account, then `setup`, which writes Pi's `~/.pi/agent/models.json`.
- Pi shows the models under one provider, `gemini-rotator`.

## Capabilities and Constraints

- Google Antigravity accounts only (Gemini, Claude and GPT-OSS models served through Cloud Code Assist).
- OpenAI Chat Completions API: streaming, tools, images, reasoning.
- Sticky or round-robin rotation, per-model cooldowns from Google's reset times.
- Written in TypeScript, no runtime dependencies, Node 20+.
- It talks to an internal Google API the way the Antigravity IDE does; it is unofficial and unaffiliated with Google or Pi.

## Brand Commitments

- Name: `pi-gemini-auth`, always lowercase.
- The project is independent. It does not use or imitate the logos or marks of Pi, Google, Gemini, Anthropic or Claude: no blocky three-colour π like Pi's logo, no four-point Gemini sparkle.
- The logo must make the Pi and Gemini connection obvious at a glance (user, 2026-11-10), through generic symbols: the mathematical π and the Gemini zodiac sign ♊.
- First visual asset: a logo mark without text (2026-11-10).

## Evidence on Hand

- `docs/pi-screenshot.png`: real screenshot of Pi answering through the rotator (gemini-3.8-flash-high).
- Live verification on 2026-11-10 against real Google accounts. No users, stars, benchmarks or testimonials exist yet; do not invent them.

## Product Principles

1. The client never notices the rotation.
2. Small and local beats feature-rich and hosted.
3. Built for Pi first; other OpenAI-compatible clients are a side effect.
4. Honest about being unofficial.
