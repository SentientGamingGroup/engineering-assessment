# How to submit

1. Fork SentientGamingGroup/engineering-assessment; create assessment/<your-handle>.
2. Implement under submission/. You may add files, dependencies and lockfiles there.
   Leave contracts/, lib/, fixtures/, scripts/, .github/ and brief documents unchanged.
   Report a suspected harness issue in your PR; do not weaken checks.
3. Keep these root commands working:

   ```sh
   npm ci --ignore-scripts
   node submission/start.mjs
   node submission/test.mjs
   node scripts/check.mjs
   ```

   Document any additional installation/code-generation step. Do not require secrets,
   external services or cloud access. Include Go modules/generated bindings if used.
4. Add submission/NOTES.md (about one page): architecture/state owner; crash and
   duplicate handling; gateway gRPC deadlines; WebSocket replay/backpressure;
   client state/timeline lifecycle; one tradeoff; gaps; actual time; AI/tool use.
5. Add submission/DEMO.md with the animation brief's manual evidence.
6. Open a PR into the organization repository targeting main, titled
   Assessment: <your GitHub handle>. Share its URL before the deadline; leave it open.

A maintainer may need to approve a first-time contributor's Actions run. This does
not affect submission time; include local test results. Do not request org write access.
Expect a 20–30 minute walkthrough and one small change. We assess code, visible
behavior, evidence and understanding together.
